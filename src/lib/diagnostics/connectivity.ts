import "server-only";

import { coreV1 } from "@/lib/k8s";
import { promQuery } from "@/lib/helpers/prometheus";
import { mediamtxListPaths } from "@/lib/helpers/mediamtx";
import { getKafka } from "@/lib/kafka";
import { makeS3Client, s3Endpoint, s3BucketForRecordings } from "@/lib/s3";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { CLUSTER } from "@/lib/cluster-refs";

export interface BackendStatus {
  id: "k8s" | "prometheus" | "mediamtx" | "kafka" | "s3" | "alert-bridge";
  label: string;
  ok: boolean;
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

async function probeMediamtx(): Promise<BackendStatus> {
  const id: BackendStatus["id"] = "mediamtx";
  const label = "camera-sim (mediamtx)";
  const t0 = Date.now();
  const { warning } = await mediamtxListPaths();
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

/**
 * Probe every backend the console depends on.
 * Each probe is wrapped in a timeout; the whole set runs concurrently.
 * Returns results in stable order: k8s, prometheus, mediamtx, kafka, s3, alert-bridge.
 * Never throws.
 */
export async function collectConnectivity(): Promise<BackendStatus[]> {
  const [k8s, prometheus, mediamtx, kafka, s3, alertBridge] = await Promise.all([
    Promise.race([probeK8s(), timeoutStatus("k8s", "K8s API", PROBE_TIMEOUT_MS)]),
    Promise.race([probePrometheus(), timeoutStatus("prometheus", "Prometheus", PROBE_TIMEOUT_MS)]),
    Promise.race([probeMediamtx(), timeoutStatus("mediamtx", "camera-sim (mediamtx)", PROBE_TIMEOUT_MS)]),
    Promise.race([probeKafka(), timeoutStatus("kafka", "Kafka", PROBE_TIMEOUT_MS)]),
    Promise.race([probeS3(), timeoutStatus("s3", "S3", PROBE_TIMEOUT_MS)]),
    Promise.race([probeAlertBridge(), timeoutStatus("alert-bridge", "Alert bridge (incidents)", PROBE_TIMEOUT_MS)]),
  ]);

  return [k8s, prometheus, mediamtx, kafka, s3, alertBridge];
}
