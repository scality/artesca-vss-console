import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type V1Pod } from "@kubernetes/client-node";
import { coreV1, watchedNamespaces } from "@/lib/k8s";
import {
  inspectContainer,
  listComposeContainers,
  runOneShotGpuContainer,
  type ComposeContainer,
} from "@/lib/helpers/docker-sock";
import { getKafka } from "@/lib/kafka";
import { s3Stats } from "@/lib/aws";
import { s3Bucket } from "@/lib/s3";
import { promQuery } from "@/lib/helpers/prometheus";
import { mediamtxListPaths } from "@/lib/helpers/mediamtx";
import type { OverviewSnapshot, GpuState, PodSummary } from "@/lib/types";

const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME ?? "mdx";

export type CollectorMode = "docker" | "k8s";

export interface OverviewResult {
  snapshot: OverviewSnapshot;
  mode: CollectorMode;
  warnings: string[];
}

export interface PodsResult {
  pods: PodSummary[];
  warnings: string[];
}

/** Returns true iff a kubeconfig is reachable — either an in-cluster
 *  service-account token or a local ~/.kube/config file. When neither
 *  exists the k8s client-node library throws at first apiserver call,
 *  so the overview collector falls back to the docker-mode empty
 *  snapshot instead of returning a 500. */
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

function emptySnapshot(takenAt: string): OverviewSnapshot {
  return {
    takenAt,
    namespaces: {},
    nim: { ready: false, warmupPct: 0, queueDepth: 0 },
    gpus: [],
    kafka: {},
    s3: { bucket: s3Bucket(), objectCount: 0, bytesTotal: 0, growth24h: 0 },
    cameraSim: { instanceState: "unreachable", pathsReady: 0, pathsTotal: 0 },
  };
}

function isDockerMode(): boolean {
  return process.env.CONSOLE_RUNTIME === "docker" || !hasKubeconfig();
}

/** Bucket compose containers by service name and aggregate health. Maps the
 *  compose service taxonomy onto the snapshot's `namespaces` field so the
 *  existing KpiGrid / PodSummaryList renders unchanged. */
function summariseComposeServices(
  containers: ComposeContainer[],
): OverviewSnapshot["namespaces"] {
  const byService: OverviewSnapshot["namespaces"] = {};
  for (const c of containers) {
    const svc = c.Labels["com.docker.compose.service"] ?? c.Names[0]?.replace(/^\//, "") ?? "unknown";
    if (!byService[svc]) byService[svc] = { total: 0, ready: 0, failed: 0 };
    byService[svc].total += 1;
    const status = (c.Status ?? "").toLowerCase();
    if (c.State === "running") {
      if (status.includes("(healthy)") || !status.includes("(")) {
        byService[svc].ready += 1;
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

async function collectDockerOverview(
  takenAt: string,
  warnings: string[],
): Promise<OverviewSnapshot> {
  const cameraSimConfigured = Boolean(
    process.env.CAMERA_SIM_HOST ?? process.env.MEDIAMTX_BASE_URL,
  );
  const s3Configured = Boolean(
    s3Bucket() && (process.env.AWS_ACCESS_KEY_ID || process.env.OBJECTSTORE_ACCESS_KEY_ID),
  );

  const [containers, nimInspect, gpuOut, mtxResult, s3] = await Promise.all([
    listComposeContainers(COMPOSE_PROJECT).catch((err) => {
      warnings.push(`docker.sock list failed: ${String(err)}`);
      return [] as ComposeContainer[];
    }),
    inspectContainer("cosmos-reason2-8b").catch(() => null),
    (async () => {
      const rtviInspect = await inspectContainer("rtvi-vlm").catch(() => null);
      const image = rtviInspect?.Config.Image ?? "nvcr.io/nvidia/vss-core/vss-rt-vlm:3.1.0";
      return runOneShotGpuContainer(
        image,
        [
          "nvidia-smi",
          "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw",
          "--format=csv,noheader,nounits",
        ],
        6_000,
      ).catch((err) => {
        warnings.push(`nvidia-smi one-shot failed: ${String(err)}`);
        return null;
      });
    })(),
    cameraSimConfigured
      ? mediamtxListPaths().catch((err) => {
          warnings.push(`mediamtx ping failed: ${String(err)}`);
          return { paths: [], warning: undefined };
        })
      : Promise.resolve({ paths: [], warning: undefined }),
    (async () => {
      const bucket = s3Bucket();
      if (!s3Configured) return { bucket: bucket || "", objectCount: 0, bytesTotal: 0, growth24h: 0 };
      try {
        const stats = await Promise.race([
          s3Stats(bucket),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error("s3Stats timeout"), { code: "ETIMEOUT" })), 5_000)
          ),
        ]);
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
  if (mtxResult.warning) warnings.push(mtxResult.warning);
  // Camera-sim mediamtx publishes two paths per camera: <name> (H.265 — what
  // VSS consumes) and <name>-h264 (transcode for browser HLS preview). The
  // dashboard counts cameras, not raw paths, so filter the transcode variants.
  const cameraPaths = mtxResult.paths.filter((p) => !p.name.endsWith("-h264"));
  const pathsReady = cameraPaths.filter((p) => p.ready).length;
  const cameraSim: OverviewSnapshot["cameraSim"] = {
    instanceState: cameraSimConfigured && cameraPaths.length > 0 ? "running" : cameraSimConfigured ? "unreachable" : "stopped",
    pathsReady,
    pathsTotal: cameraPaths.length,
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

async function collectK8sOverview(
  takenAt: string,
  warnings: string[],
): Promise<OverviewSnapshot> {
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

  const gpus: GpuState[] = [];
  const gpuQueries = [
    "DCGM_FI_DEV_GPU_UTIL",
    "DCGM_FI_DEV_FB_USED",
    "DCGM_FI_DEV_FB_TOTAL",
    "DCGM_FI_DEV_GPU_TEMP",
    "DCGM_FI_DEV_POWER_USAGE",
  ] as const;

  const gpuResults = await Promise.all(gpuQueries.map((q) => promQuery(q)));

  for (const r of gpuResults) {
    if (r.warning) warnings.push(r.warning);
  }

  const [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes] = gpuResults;

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

  const kafka: OverviewSnapshot["kafka"] = {};
  const topicsEnv = process.env.KAFKA_TOPICS ?? "vision-llm-events,alerts";
  const topics = topicsEnv.split(",").map((t) => t.trim()).filter(Boolean);

  const { instance: kafkaInstance } = getKafka();
  if (kafkaInstance) {
    try {
      const admin = kafkaInstance.admin();
      await admin.connect();
      try {
        for (const topic of topics) {
          let lag = 0;
          try {
            const offsets = await admin.fetchTopicOffsets(topic);
            lag = offsets.reduce((sum, p) => sum + parseInt(p.high, 10) - parseInt(p.low, 10), 0);
          } catch {
            // ignore per-topic failure
          }
          kafka[topic] = { topic, consumerLagMsgs: lag };
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

  let cameraSim: OverviewSnapshot["cameraSim"] = {
    instanceState: "unreachable",
    pathsReady: 0,
    pathsTotal: 0,
  };
  try {
    const { paths, warning } = await mediamtxListPaths();
    if (warning) warnings.push(warning);
    // Filter out -h264 transcodes (browser HLS preview duplicates) so the
    // count reflects cameras, not raw mediamtx paths. Standalone camera-sim
    // publishes two paths per camera; in-cluster pyramid-ingress publishes
    // one — filter is a no-op there.
    const cameraPaths = paths.filter((p) => !p.name.endsWith("-h264"));
    const pathsReady = cameraPaths.filter((p) => p.ready).length;
    cameraSim = {
      instanceState: cameraPaths.length > 0 || !warning ? "running" : "unreachable",
      pathsReady,
      pathsTotal: cameraPaths.length,
    };
  } catch (err) {
    warnings.push(`Camera-sim ping failed: ${String(err)}`);
  }

  return {
    takenAt,
    namespaces,
    nim,
    gpus,
    kafka,
    s3,
    cameraSim,
  };
}

/** Always-resolves overview collector. Any unhandled error during collection
 *  is captured into `warnings` and a degraded (empty-but-valid) snapshot is
 *  returned, so the page never has to handle "the call itself failed." */
export async function collectOverviewSnapshot(): Promise<OverviewResult> {
  const warnings: string[] = [];
  const takenAt = new Date().toISOString();
  const mode: CollectorMode = isDockerMode() ? "docker" : "k8s";
  try {
    const snapshot = mode === "docker"
      ? await collectDockerOverview(takenAt, warnings)
      : await collectK8sOverview(takenAt, warnings);
    return { snapshot, mode, warnings };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[overview] collector threw: ${reason}`);
    warnings.push(`collector threw: ${reason}`);
    return { snapshot: emptySnapshot(takenAt), mode, warnings };
  }
}

function podAge(startTime: Date | string | undefined): string {
  if (!startTime) return "?";
  const ms = Date.now() - new Date(startTime).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d${hrs % 24}h`;
}

function summarisePod(pod: V1Pod, ns: string): PodSummary {
  const phase = (pod.status?.phase ?? "Unknown") as PodSummary["phase"];
  const containers = pod.status?.containerStatuses ?? [];
  const restarts = containers.reduce((s, c) => s + (c.restartCount ?? 0), 0);
  const ready =
    pod.status?.conditions?.some(
      (c) => c.type === "Ready" && c.status === "True"
    ) ?? false;

  const gpuAnnotation = pod.metadata?.annotations?.["nvidia.com/gpu.present"];
  const gpus = gpuAnnotation ? 1 : undefined;

  return {
    namespace: ns,
    name: pod.metadata?.name ?? "?",
    phase,
    ready,
    restarts,
    age: podAge(pod.status?.startTime),
    node: pod.spec?.nodeName,
    gpus,
  };
}

/** Always-resolves pods collector. Mirrors collectOverviewSnapshot's
 *  failure-tolerant contract: warnings, never throws. `nsFilter` accepts
 *  a single namespace name (or "all" / undefined for every watched ns). */
export async function collectPodSummaries(nsFilter?: string): Promise<PodsResult> {
  const warnings: string[] = [];
  try {
    if (isDockerMode()) {
      const containers = await listComposeContainers(COMPOSE_PROJECT);
      const pods: PodSummary[] = containers.map((c) => {
        const svc = c.Labels["com.docker.compose.service"] ?? c.Names[0]?.replace(/^\//, "") ?? "unknown";
        const running = c.State === "running";
        const status = (c.Status ?? "").toLowerCase();
        const exitMatch = status.match(/exited \((\d+)\)/);
        const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
        const succeeded = c.State === "exited" && exitCode === 0;
        const healthy = running && (status.includes("(healthy)") || !status.includes("("));
        const phase: PodSummary["phase"] = running ? "Running" : succeeded ? "Succeeded" : "Failed";
        return {
          namespace: svc,
          name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
          phase,
          ready: running ? healthy : succeeded,
          restarts: 0,
          age: c.Status ?? "?",
        };
      });
      return { pods, warnings };
    }

    const namespaces = !nsFilter || nsFilter === "all" ? watchedNamespaces() : [nsFilter];
    const pods: PodSummary[] = [];

    await Promise.allSettled(
      namespaces.map(async (namespace) => {
        try {
          const podList = await coreV1().listNamespacedPod({ namespace });
          for (const pod of podList.items) {
            pods.push(summarisePod(pod, namespace));
          }
        } catch (err) {
          warnings.push(`Failed to list pods in ${namespace}: ${String(err)}`);
        }
      })
    );

    return { pods, warnings };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[pods] collector threw: ${reason}`);
    warnings.push(`collector threw: ${reason}`);
    return { pods: [], warnings };
  }
}
