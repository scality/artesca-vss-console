import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { coreV1, watchedNamespaces } from "@/lib/k8s";
import {
  execInContainer,
  inspectContainer,
  listComposeContainers,
  type ComposeContainer,
} from "@/lib/helpers/docker-sock";

/** Returns true iff a kubeconfig is reachable — either an in-cluster
 *  service-account token or a local ~/.kube/config file. When neither
 *  exists the k8s client-node library throws at first apiserver call,
 *  so the overview route falls back to the docker-mode empty snapshot
 *  instead of returning a 500. */
function hasKubeconfig(): boolean {
  if (existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) {
    return true;
  }
  if (process.env.KUBECONFIG && existsSync(process.env.KUBECONFIG)) {
    return true;
  }
  try {
    return existsSync(join(homedir(), ".kube", "config"));
  } catch {
    return false;
  }
}
import { getKafka } from "@/lib/kafka";
import { s3Stats } from "@/lib/aws";
import { s3Bucket } from "@/lib/s3";
import { promQuery } from "@/lib/helpers/prometheus";
import { mediamtxListPaths } from "@/lib/helpers/mediamtx";
import type { OverviewSnapshot, GpuState } from "@/lib/types";

export const dynamic = "force-dynamic";

const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME ?? "mdx";

/** Bucket compose containers by service name and aggregate health.
 *  Maps the compose service taxonomy onto the snapshot's `namespaces`
 *  field so the existing KpiGrid / PodSummaryList renders unchanged
 *  ("services" instead of "namespaces" is just a label difference). */
function summariseComposeServices(
  containers: ComposeContainer[],
): OverviewSnapshot["namespaces"] {
  // Group containers by their compose-service. Each service gets a
  // {total, ready, failed} bucket — total = number of replicas of that
  // service, ready = those with healthcheck=healthy or running-no-healthcheck,
  // failed = exited or unhealthy.
  const byService: OverviewSnapshot["namespaces"] = {};
  for (const c of containers) {
    const svc = c.Labels["com.docker.compose.service"] ?? c.Names[0]?.replace(/^\//, "") ?? "unknown";
    if (!byService[svc]) byService[svc] = { total: 0, ready: 0, failed: 0 };
    byService[svc].total += 1;
    const status = (c.Status ?? "").toLowerCase();
    if (c.State === "running") {
      if (status.includes("(healthy)") || !status.includes("(")) {
        byService[svc].ready += 1;
      } else if (status.includes("(unhealthy)") || status.includes("(starting)")) {
        // count as not-ready but not failed yet
      }
    } else {
      byService[svc].failed += 1;
    }
  }
  return byService;
}

/** Parse `nvidia-smi --query-gpu=...` CSV output into GpuState[].
 *  Header: index, name, memory.total, memory.used, utilization.gpu,
 *          temperature.gpu, power.draw  (units: MiB, MiB, %, C, W). */
function parseNvidiaSmiCsv(out: string): GpuState[] {
  const gpus: GpuState[] = [];
  for (const line of out.split("\n")) {
    const cols = line.split(",").map((s) => s.trim());
    if (cols.length < 7 || !cols[0] || isNaN(parseInt(cols[0], 10))) continue;
    const index = parseInt(cols[0], 10);
    const memTotal = parseFloat(cols[2]) || 0;
    const memUsed = parseFloat(cols[3]) || 0;
    gpus.push({
      index,
      name: cols[1] || `GPU ${index}`,
      memoryUsedMiB: memUsed,
      memoryTotalMiB: memTotal || 1,
      utilGpu: parseFloat(cols[4]) || 0,
      utilMem: memTotal > 0 ? (memUsed / memTotal) * 100 : 0,
      tempC: parseFloat(cols[5]) || 0,
      powerW: parseFloat(cols[6]) || 0,
      processes: [],
    });
  }
  return gpus;
}

/** Build an OverviewSnapshot from docker-side data sources: docker.sock for
 *  container state + healthchecks, `nvidia-smi` via Exec API on a GPU-enabled
 *  container for live GPU metrics, mediamtx for camera-sim state, and S3
 *  stats when OBJECTSTORE_* creds are configured. The k8s probes (Prometheus,
 *  ConfigMap, Kafka admin) are skipped — kafka lag is left at zero on this
 *  path until a docker-side equivalent is wired. */
async function collectDockerOverview(
  takenAt: string,
  warnings: string[],
): Promise<OverviewSnapshot> {
  const [containers, nimInspect, gpuOut, mtxResult, s3] = await Promise.all([
    listComposeContainers(COMPOSE_PROJECT),
    inspectContainer("cosmos-reason2-8b"),
    // rtvi-vlm has the nvidia runtime + nvidia-smi binary baked in. Querying
    // it via Exec avoids the privilege escalation that hitting /proc/driver/
    // nvidia from outside the container would need. Bounded 4 s timeout —
    // we'd rather miss a frame of GPU data than block the dashboard tick.
    execInContainer(
      "rtvi-vlm",
      [
        "nvidia-smi",
        "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
      ],
      4_000,
    ),
    mediamtxListPaths().catch((err) => {
      warnings.push(`mediamtx ping failed: ${String(err)}`);
      return { paths: [], warning: undefined };
    }),
    (async () => {
      const bucket = s3Bucket();
      if (!bucket) return { bucket: "", objectCount: 0, bytesTotal: 0, growth24h: 0 };
      try {
        const stats = await s3Stats(bucket);
        return { ...stats, growth24h: 0 };
      } catch (err) {
        warnings.push(`S3 stats failed: ${String(err)}`);
        return { bucket, objectCount: 0, bytesTotal: 0, growth24h: 0 };
      }
    })(),
  ]);

  const namespaces = summariseComposeServices(containers);
  if (containers.length === 0) {
    warnings.push(`No containers found for compose project "${COMPOSE_PROJECT}"`);
  }

  const nimReady = nimInspect?.State?.Health?.Status === "healthy" ||
    (nimInspect?.State?.Running === true && !nimInspect?.State?.Health);
  const nim: OverviewSnapshot["nim"] = {
    ready: nimReady,
    warmupPct: nimReady ? 100 : nimInspect?.State?.Running ? 50 : 0,
    queueDepth: 0,
  };

  const gpus = gpuOut ? parseNvidiaSmiCsv(gpuOut) : [];
  if (!gpuOut) warnings.push("nvidia-smi unavailable (rtvi-vlm exec failed)");

  if (mtxResult.warning) warnings.push(mtxResult.warning);
  const pathsReady = mtxResult.paths.filter((p) => p.ready).length;
  const cameraSim: OverviewSnapshot["cameraSim"] = {
    instanceState: mtxResult.paths.length > 0 ? "running" : "unreachable",
    pathsReady,
    pathsTotal: mtxResult.paths.length,
  };

  return {
    takenAt,
    namespaces,
    nim,
    gpus,
    kafka: {},
    s3,
    cameraSim,
  };
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];
  const takenAt = new Date().toISOString();

  // Docker-runtime branch: return an empty-but-valid OverviewSnapshot so
  // the home page renders without warnings instead of bombing with k8s
  // API errors. The docker compose stack is its own world (no kubectl,
  // no Prometheus, no Kafka admin via the k8s service); the operator
  // navigates to /topology + /chat + /cameras instead.
  //
  // Detection order:
  //   1. Explicit CONSOLE_RUNTIME=docker env (always wins).
  //   2. Auto-detect: no service-account token under /var/run/secrets/
  //      kubernetes.io AND no ~/.kube/config — the k8s client-node would
  //      throw at first apiserver call, so we short-circuit deterministically.
  if (
    process.env.CONSOLE_RUNTIME === "docker" ||
    !hasKubeconfig()
  ) {
    const snap = await collectDockerOverview(takenAt, warnings);
    return NextResponse.json({ ...snap, mode: "docker", warnings });
  }

  // ── Pod counts per namespace ────────────────────────────────────────────────
  const namespaces: OverviewSnapshot["namespaces"] = {};
  const nsListResults = await Promise.allSettled(
    watchedNamespaces().map(async (ns) => {
      const podList = await coreV1().listNamespacedPod({ namespace: ns });
      return { ns, pods: podList.items };
    })
  );

  for (const result of nsListResults) {
    if (result.status === "rejected") {
      warnings.push(`K8s pod list failed: ${String(result.reason)}`);
      continue;
    }
    const { ns, pods } = result.value;
    let total = 0, ready = 0, failed = 0;
    for (const pod of pods) {
      total++;
      const phase = pod.status?.phase;
      if (phase === "Failed" || phase === "Unknown") {
        failed++;
      } else if (
        pod.status?.conditions?.find(
          (c) => c.type === "Ready" && c.status === "True"
        )
      ) {
        ready++;
      }
    }
    namespaces[ns] = { total, ready, failed };
  }

  // ── NIM readiness (rtvi namespace) ─────────────────────────────────────────
  let nim: OverviewSnapshot["nim"] = { ready: false, warmupPct: 0, queueDepth: 0 };
  try {
    const rtviPodList = await coreV1().listNamespacedPod({ namespace: "rtvi" });
    const nimPods = rtviPodList.items.filter((p) =>
      p.metadata?.name?.includes("nim")
    );
    const anyReady = nimPods.some((p) =>
      p.status?.conditions?.find(
        (c) => c.type === "Ready" && c.status === "True"
      )
    );
    nim = { ready: anyReady, warmupPct: anyReady ? 100 : 0, queueDepth: 0 };
  } catch (err) {
    warnings.push(`NIM status failed: ${String(err)}`);
  }

  // ── GPU metrics from Prometheus ─────────────────────────────────────────────
  const gpus: GpuState[] = [];
  const gpuQueries = [
    "DCGM_FI_DEV_GPU_UTIL",
    "DCGM_FI_DEV_FB_USED",
    "DCGM_FI_DEV_FB_TOTAL",
    "DCGM_FI_DEV_GPU_TEMP",
    "DCGM_FI_DEV_POWER_USAGE",
  ] as const;

  const gpuResults = await Promise.all(gpuQueries.map((q) => promQuery(q)));

  // Collect warnings from GPU queries
  for (let i = 0; i < gpuResults.length; i++) {
    if (gpuResults[i].warning) {
      warnings.push(gpuResults[i].warning!);
    }
  }

  const [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes] = gpuResults;

  // Build GPU index set from all results combined
  const gpuIndexMap = new Map<
    string,
    { index: string; gpu: string; name?: string }
  >();

  for (const r of [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes]) {
    for (const item of r.results) {
      const gpuIdx = item.metric["gpu"] ?? item.metric["GPU"] ?? "0";
      if (!gpuIndexMap.has(gpuIdx)) {
        gpuIndexMap.set(gpuIdx, { index: gpuIdx, gpu: gpuIdx, name: item.metric["modelName"] });
      }
    }
  }

  for (const [gpuIdx, meta] of gpuIndexMap) {
    const getVal = (res: (typeof gpuResults)[number]) => {
      const found = res.results.find(
        (r) => (r.metric["gpu"] ?? r.metric["GPU"]) === gpuIdx
      );
      return found ? parseFloat(found.value[1]) : 0;
    };

    const fbUsed = getVal(fbUsedRes);
    const fbTotal = getVal(fbTotalRes);

    gpus.push({
      index: parseInt(meta.index, 10),
      name: meta.name ?? `GPU ${gpuIdx}`,
      memoryUsedMiB: fbUsed,
      memoryTotalMiB: fbTotal || 1,
      utilGpu: getVal(utilRes),
      utilMem: fbTotal > 0 ? (fbUsed / fbTotal) * 100 : 0,
      tempC: getVal(tempRes),
      powerW: getVal(powerRes),
      processes: [],
    });
  }

  // ── Kafka consumer lag ──────────────────────────────────────────────────────
  const kafka: OverviewSnapshot["kafka"] = {};
  const topicsEnv = process.env.KAFKA_TOPICS ?? "vision-llm-events,alerts";
  const topics = topicsEnv.split(",").map((t) => t.trim()).filter(Boolean);

  const { instance: kafkaInstance } = getKafka();
  if (kafkaInstance) {
    try {
      const admin = kafkaInstance.admin();
      await admin.connect();
      try {
        const offsetData = await admin.fetchTopicOffsets(topics[0] ?? "vision-llm-events");
        // Simple approach: sum all partition offsets as proxy for lag
        for (const topic of topics) {
          let lag = 0;
          try {
            const offsets = await admin.fetchTopicOffsets(topic);
            lag = offsets.reduce((sum, p) => sum + parseInt(p.high, 10) - parseInt(p.low, 10), 0);
          } catch {
            // ignore per-topic failure
          }
          kafka[topic] = { topic, consumerLagMsgs: lag };
          void offsetData; // silence unused warning
        }
      } finally {
        await admin.disconnect();
      }
    } catch (err) {
      warnings.push(`Kafka admin failed: ${String(err)}`);
      for (const topic of topics) {
        kafka[topic] = { topic, consumerLagMsgs: 0 };
      }
    }
  } else {
    warnings.push("Kafka not configured — KAFKA_BROKERS not set");
    for (const topic of topics) {
      kafka[topic] = { topic, consumerLagMsgs: 0 };
    }
  }

  // ── S3 stats ────────────────────────────────────────────────────────────────
  const bucket = s3Bucket();
  let s3: OverviewSnapshot["s3"] = {
    bucket,
    objectCount: 0,
    bytesTotal: 0,
    growth24h: 0,
  };
  try {
    const stats = await s3Stats(bucket);
    s3 = { ...stats, growth24h: 0 };
  } catch (err) {
    warnings.push(`S3 stats failed: ${String(err)}`);
  }

  // ── Camera-sim state via mediamtx ──────────────────────────────────────────
  let cameraSim: OverviewSnapshot["cameraSim"] = {
    instanceState: "unreachable",
    pathsReady: 0,
    pathsTotal: 0,
  };
  try {
    const { paths, warning } = await mediamtxListPaths();
    if (warning) warnings.push(warning);
    const pathsReady = paths.filter((p) => p.ready).length;
    cameraSim = {
      instanceState: paths.length > 0 || !warning ? "running" : "unreachable",
      pathsReady,
      pathsTotal: paths.length,
    };
  } catch (err) {
    warnings.push(`Camera-sim ping failed: ${String(err)}`);
  }

  const snapshot: OverviewSnapshot = {
    takenAt,
    namespaces,
    nim,
    gpus,
    kafka,
    s3,
    cameraSim,
  };

  return NextResponse.json({ ...snapshot, warnings });
}
