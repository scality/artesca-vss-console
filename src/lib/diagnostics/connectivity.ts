import "server-only";

import { coreV1 } from "@/lib/k8s";
import { promQuery } from "@/lib/helpers/prometheus";
import { getKafka } from "@/lib/kafka";
import { makeS3Client, s3Endpoint, s3BucketForRecordings } from "@/lib/s3";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { CLUSTER } from "@/lib/cluster-refs";
import { vstListSensors } from "@/lib/helpers/vst";

export interface BackendStatus {
  id: "k8s" | "prometheus" | "kafka" | "vst" | "s3" | "alert-bridge" | "config-store";
  label: string;
  ok: boolean;
  /** Optional finer grade. Absent → derived as ok?"ok":"error". "warn" = healthy
   *  but degraded (rendered amber), e.g. reconcile loop disabled. */
  severity?: "ok" | "warn" | "error";
  detail: string;
  latencyMs: number;
}

const PROBE_TIMEOUT_MS = 4_000;

/** Resolve to a "timed out" status after `ms` milliseconds. */
function timeoutStatus(
  id: BackendStatus["id"],
  label: string,
  ms: number
): Promise<BackendStatus> {
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          id,
          label,
          ok: false,
          detail: `probe timed out after ${ms}ms`,
          latencyMs: ms,
        }),
      ms
    )
  );
}

async function probeK8s(): Promise<BackendStatus> {
  const id: BackendStatus["id"] = "k8s";
  const label = "K8s API";
  const t0 = Date.now();
  try {
    await coreV1().listNamespace();
    return { id, label, ok: true, detail: "reachable", latencyMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id, label, ok: false, detail: msg, latencyMs: Date.now() - t0 };
  }
}

async function probePrometheus(): Promise<BackendStatus> {
  const id: BackendStatus["id"] = "prometheus";
  const label = "Prometheus";
  const t0 = Date.now();
  const { warning } = await promQuery("up");
  return {
    id,
    label,
    ok: !warning,
    detail: warning ?? "reachable",
    latencyMs: Date.now() - t0,
  };
}

async function probeKafka(): Promise<BackendStatus> {
  const id: BackendStatus["id"] = "kafka";
  const label = "Kafka";
  const t0 = Date.now();

  const { instance } = getKafka();
  if (!instance) {
    return {
      id,
      label,
      ok: false,
      detail: "not configured (KAFKA_BROKERS unset)",
      latencyMs: Date.now() - t0,
    };
  }

  const admin = instance.admin();
  try {
    await admin.connect();
    await admin.listTopics();
    return { id, label, ok: true, detail: "reachable", latencyMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id, label, ok: false, detail: msg, latencyMs: Date.now() - t0 };
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

async function probeS3(): Promise<BackendStatus> {
  const id: BackendStatus["id"] = "s3";
  const label = "S3";
  const t0 = Date.now();

  if (!s3Endpoint()) {
    return {
      id,
      label,
      ok: false,
      detail: "not configured",
      latencyMs: Date.now() - t0,
    };
  }

  try {
    const client = makeS3Client();
    const bucket = s3BucketForRecordings();
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { id, label, ok: true, detail: "reachable", latencyMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id, label, ok: false, detail: msg, latencyMs: Date.now() - t0 };
  }
}

async function probeVst(): Promise<BackendStatus> {
  const id: BackendStatus["id"] = "vst";
  const label = "Cameras (VST)";
  const t0 = Date.now();
  // Source-agnostic camera reachability: VST is the registry every camera
  // (GCP sim, AWS sim, real cameras) registers into. Reachable + how many
  // sensors are online. vstListSensors never throws (returns a warning).
  const { sensors, warning } = await vstListSensors();
  if (warning) {
    return { id, label, ok: false, detail: warning, latencyMs: Date.now() - t0 };
  }
  const active = sensors.filter((s) => s.status !== "removed");
  const online = active.filter((s) => s.status === "online").length;
  return {
    id,
    label,
    ok: true,
    severity: online === 0 && active.length > 0 ? "warn" : "ok",
    detail: `reachable · ${online}/${active.length} cameras online`,
    latencyMs: Date.now() - t0,
  };
}

async function probeAlertBridge(): Promise<BackendStatus> {
  const id: BackendStatus["id"] = "alert-bridge";
  const label = "Alert bridge (incidents)";
  const t0 = Date.now();

  // The alert-bridge is the incident SOURCE — GET /api/v1/realtime/incidents
  // serves them. A limit=1 read is the cheapest liveness probe of the path
  // the Incidents page depends on.
  const url = `${CLUSTER.alertBridge.realtimeUrl}/incidents?limit=1`;
  try {
    const resp = await fetch(url, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { id, label, ok: false, detail: `HTTP ${resp.status}`, latencyMs: Date.now() - t0 };
    }
    return { id, label, ok: true, detail: "reachable", latencyMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id, label, ok: false, detail: msg, latencyMs: Date.now() - t0 };
  }
}

export async function probeConfigStore(): Promise<BackendStatus> {
  const id: BackendStatus["id"] = "config-store";
  const label = "Config store (Firestore)";
  const t0 = Date.now();
  const fail = (detail: string): BackendStatus => ({ id, label, ok: false, severity: "error", detail, latencyMs: Date.now() - t0 });

  if (!process.env.VSS_INSTANCE_NAME) return fail("VSS_INSTANCE_NAME unset");

  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  let ctx: Awaited<ReturnType<typeof makeReconcileContext>>;
  try {
    ctx = await makeReconcileContext();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  let status: { lastRunAt?: string; errors?: string[] } | null;
  try {
    status = (await ctx.store.readStatus(ctx.instance)) as { lastRunAt?: string; errors?: string[] } | null;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // Reachability only: a successful readStatus means Firestore is reachable.
  // Reconcile-run errors are an application-health concern, not a store-
  // reachability one — surface them in the detail text but never downgrade the
  // signal, so a failing convergence doesn't masquerade as "Firestore degraded".
  const when = status?.lastRunAt ? ` ${status.lastRunAt}` : "";
  const errs = status?.errors?.length ?? 0;
  const detail = !status?.lastRunAt
    ? "reachable"
    : errs > 0
      ? `reachable · last convergence${when} had ${errs} error(s)`
      : `reachable · converged${when}`;
  return { id, label, ok: true, severity: "ok", detail, latencyMs: Date.now() - t0 };
}

/**
 * Probe every backend the console depends on.
 * Each probe is wrapped in a timeout; the whole set runs concurrently.
 * Returns results in stable order: k8s, prometheus, kafka, vst, s3, alert-bridge, config-store.
 * Never throws.
 */
export async function collectConnectivity(): Promise<BackendStatus[]> {
  const [k8s, prometheus, kafka, vst, s3, alertBridge, configStore] = await Promise.all([
    Promise.race([probeK8s(), timeoutStatus("k8s", "K8s API", PROBE_TIMEOUT_MS)]),
    Promise.race([probePrometheus(), timeoutStatus("prometheus", "Prometheus", PROBE_TIMEOUT_MS)]),
    Promise.race([probeKafka(), timeoutStatus("kafka", "Kafka", PROBE_TIMEOUT_MS)]),
    Promise.race([probeVst(), timeoutStatus("vst", "Cameras (VST)", PROBE_TIMEOUT_MS)]),
    Promise.race([probeS3(), timeoutStatus("s3", "S3", PROBE_TIMEOUT_MS)]),
    Promise.race([probeAlertBridge(), timeoutStatus("alert-bridge", "Alert bridge (incidents)", PROBE_TIMEOUT_MS)]),
    Promise.race([probeConfigStore(), timeoutStatus("config-store", "Config store (Firestore)", PROBE_TIMEOUT_MS)]),
  ]);

  return [k8s, prometheus, kafka, vst, s3, alertBridge, configStore];
}
