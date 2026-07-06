import "server-only";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type V1Pod } from "@kubernetes/client-node";
import { coreV1, listAllPodsInNs, watchedNamespaces } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";
import { createLogger } from "@/lib/logger";

const log = createLogger("overview-collector");
import {
  inspectContainer,
  listComposeContainers,
  runOneShotGpuContainer,
  type ComposeContainer,
} from "@/lib/helpers/docker-sock";
import { getKafka } from "@/lib/kafka";
import { s3Stats } from "@/lib/aws";
import { s3BucketForRecordings, describeS3Error } from "@/lib/s3";
import { promQuery } from "@/lib/helpers/prometheus";
import { mediamtxListPaths } from "@/lib/helpers/mediamtx";
import { vstListSensors } from "@/lib/helpers/vst";
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
    s3: { bucket: s3BucketForRecordings(), objectCount: 0, bytesTotal: 0, growth24h: 0, bytesCapacity: CLUSTER.s3.capacityBytes },
    cameraSim: { instanceState: "unreachable", pathsReady: 0, pathsTotal: 0, cameras: [] },
  };
}

function isDockerMode(): boolean {
  // CONSOLE_RUNTIME is an explicit override in both directions. Only fall back
  // to kubeconfig autodetection when it is unset — otherwise mode would depend
  // on whether a ~/.kube/config happens to exist on the host (true on a dev
  // laptop, false in CI), which made the k8s-mode unit tests environment-flaky.
  if (process.env.CONSOLE_RUNTIME === "docker") return true;
  if (process.env.CONSOLE_RUNTIME === "k8s") return false;
  return !hasKubeconfig();
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
    s3BucketForRecordings() && (process.env.AWS_ACCESS_KEY_ID || process.env.OBJECTSTORE_ACCESS_KEY_ID),
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
      const bucket = s3BucketForRecordings();
      const capacity = CLUSTER.s3.capacityBytes;
      if (!s3Configured) return { bucket: bucket || "", objectCount: 0, bytesTotal: 0, growth24h: 0, bytesCapacity: capacity };
      try {
        const stats = await Promise.race([
          s3Stats(bucket),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error("s3Stats timeout"), { code: "ETIMEOUT" })), 5_000)
          ),
        ]);
        return { ...stats, growth24h: stats.bytesLast24h, bytesCapacity: capacity };
      } catch (err) {
        warnings.push(`S3 stats failed: ${describeS3Error(err)}`);
        return { bucket, objectCount: 0, bytesTotal: 0, growth24h: 0, bytesCapacity: capacity };
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
    // Docker overview has no VST sensor list — liveness from mediamtx readiness.
    cameras: cameraPaths.map((p) => ({ name: p.name, live: p.ready })),
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
      const pods = await listAllPodsInNs(coreV1(), ns);
      return { ns, pods };
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
        phase === "Succeeded" ||
        pod.status?.conditions?.find(
          (c) => c.type === "Ready" && c.status === "True"
        )
      ) {
        // Succeeded = completed Job (terminal success, no Ready condition);
        // count it as ready so the namespace ratio isn't dragged below total.
        ready++;
      }
    }
    namespaces[ns] = { total, ready, failed };
  }

  let nim: OverviewSnapshot["nim"] = { ready: false, warmupPct: 0, queueDepth: 0 };
  try {
    // Helm: NIM pods are in vss-<profile> namespace, named nvidia-nemotron-nano-9b-v2-*.
    // Legacy: NIM pods are in rtvi namespace.
    const nimNs = CLUSTER.rtvi.nimNamespace;
    const nimPods_ = await listAllPodsInNs(coreV1(), nimNs);
    const nimPods = nimPods_.filter((p) =>
      p.metadata?.name?.includes("nim") || p.metadata?.name?.includes("nemotron") || p.metadata?.name?.includes("cosmos") || p.metadata?.name?.includes("vlm")
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
    // Some DCGM exporter builds emit FB_FREE but not FB_TOTAL — derive total
    // from used + free in that case (see memoryTotalMiB below).
    "DCGM_FI_DEV_FB_FREE",
  ] as const;

  const gpuResults = await Promise.all(gpuQueries.map((q) => promQuery(q)));

  for (const r of gpuResults) {
    if (r.warning) warnings.push(r.warning);
  }

  const [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes, fbFreeRes] = gpuResults;

  const gpuIndexMap = new Map<
    string,
    { index: string; gpu: string; name?: string }
  >();

  for (const r of [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes, fbFreeRes]) {
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
    const fbFree = getVal(fbFreeRes);
    // Prefer FB_TOTAL; fall back to used+free when the exporter omits TOTAL.
    const memTotal = fbTotal || (fbUsed + fbFree) || 1;

    gpus.push({
      index: parseInt(meta.index, 10),
      name: meta.name ?? `GPU ${gpuIdx}`,
      memoryUsedMiB: fbUsed,
      memoryTotalMiB: memTotal,
      utilGpu: getVal(utilRes),
      utilMem: fbTotal > 0 ? (fbUsed / fbTotal) * 100 : 0,
      tempC: getVal(tempRes),
      powerW: getVal(powerRes),
      processes: [],
    });
  }

  const kafka: OverviewSnapshot["kafka"] = {};
  // cluster-refs is the canonical topic source (calibrated per profile). Default
  // to the two core pipeline topics the alert worker consumes; querying topics
  // that don't exist on the broker yields null lag for every topic, which the
  // KPI renders as a false "brokers unreachable". KAFKA_TOPICS overrides.
  const topics = process.env.KAFKA_TOPICS
    ? process.env.KAFKA_TOPICS.split(",").map((t) => t.trim()).filter(Boolean)
    : [CLUSTER.kafka.topics.visionLlm, CLUSTER.kafka.topics.incidents];

  const { instance: kafkaInstance } = getKafka();
  if (kafkaInstance) {
    // Hard cap the whole Kafka probe — an unreachable broker otherwise retries
    // for minutes and hangs the overview page (same guard as the S3 stats
    // above). On timeout the topics read null = "unreachable", never a false 0.
    const KAFKA_PROBE_MS = 6_000;
    const probeKafka = async () => {
      const admin = kafkaInstance.admin();
      await admin.connect();
      try {
        for (const topic of topics) {
          // Topic depth = high − low watermark (messages retained in the
          // topic), NOT consumer-group lag. null = couldn't measure (≠ a real 0).
          let depth: number | null = null;
          try {
            const offsets = await admin.fetchTopicOffsets(topic);
            depth = offsets.reduce((sum, p) => sum + parseInt(p.high, 10) - parseInt(p.low, 10), 0);
          } catch {
            // per-topic failure → leave depth null (unknown), not 0.
          }
          kafka[topic] = { topic, retainedMsgs: depth };
        }
      } finally {
        admin.disconnect().catch(() => {});
      }
    };
    try {
      await Promise.race([
        probeKafka(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Kafka probe timeout after ${KAFKA_PROBE_MS}ms`)), KAFKA_PROBE_MS)
        ),
      ]);
    } catch (err) {
      // Broker unreachable / timed out — lag is unknown, NOT zero. Surfacing 0
      // here would render a false "OK" while the cluster is actually down.
      warnings.push(`Kafka admin failed: ${String(err)}`);
      for (const topic of topics) {
        if (!kafka[topic]) kafka[topic] = { topic, retainedMsgs: null };
      }
    }
  } else {
    warnings.push("Kafka not configured — KAFKA_BROKERS not set");
    for (const topic of topics) {
      kafka[topic] = { topic, retainedMsgs: null };
    }
  }

  const bucket = s3BucketForRecordings();
  let s3: OverviewSnapshot["s3"] = {
    bucket,
    objectCount: 0,
    bytesTotal: 0,
    growth24h: 0,
    bytesCapacity: CLUSTER.s3.capacityBytes,
  };
  try {
    const stats = await s3Stats(bucket);
    s3 = { ...stats, growth24h: stats.bytesLast24h, bytesCapacity: CLUSTER.s3.capacityBytes };
  } catch (err) {
    warnings.push(`S3 stats failed: ${describeS3Error(err)}`);
  }

  let cameraSim: OverviewSnapshot["cameraSim"] = {
    instanceState: "unreachable",
    pathsReady: 0,
    pathsTotal: 0,
    cameras: [],
  };
  try {
    // VST is the source-agnostic camera registry — every sensor it records,
    // regardless of which source (GCP sim, AWS sim, or real cameras) feeds it.
    // Liveness is the VST sensor's own online state; the console no longer
    // classifies cameras as synthetic vs real or probes a privileged mediamtx.
    const vst = await vstListSensors().catch(() => ({
      sensors: [] as Awaited<ReturnType<typeof vstListSensors>>["sensors"],
      warning: undefined as string | undefined,
    }));
    if (vst.warning) warnings.push(vst.warning);
    const seen = new Set<string>();
    const cameras: NonNullable<OverviewSnapshot["cameraSim"]["cameras"]> = [];
    for (const s of vst.sensors) {
      const name = typeof s.name === "string" ? s.name : "";
      if (!name || seen.has(name) || s.status === "removed") continue;
      seen.add(name);
      cameras.push({ name, live: s.status === "online" });
    }
    cameras.sort((a, b) => a.name.localeCompare(b.name));
    const liveCount = cameras.filter((c) => c.live).length;
    cameraSim = {
      instanceState: vst.warning ? "unreachable" : "running",
      pathsReady: liveCount,
      pathsTotal: cameras.length,
      cameras,
    };
  } catch (err) {
    warnings.push(`VST sensor list failed: ${String(err)}`);
  }

  // VLM-ingestion count — cameras with an active realtime alert rule, i.e.
  // actually feeding the alert pipeline (not just VST-registered/online).
  // Reuses the same signal /cameras surfaces via helpers/ingestion.ts. Kept
  // separate from the block above so a broken alert-bridge probe degrades
  // only this sub-count, never the cameras KPI itself.
  try {
    const { listIngestingCameras } = await import("@/lib/helpers/ingestion");
    const { ingesting, warning } = await listIngestingCameras();
    if (warning) {
      warnings.push(warning);
    } else {
      const known = cameraSim.cameras ?? [];
      cameraSim.ingestingCount = known.filter((c) => ingesting.has(c.name)).length;
    }
  } catch (err) {
    warnings.push(`VLM ingestion status failed: ${String(err)}`);
  }

  // Recording-recovery counts — pure in-memory read of the reconcile loop's
  // guarded auto-heal state, no extra I/O. Best-effort: omit on failure.
  let recording: OverviewSnapshot["recording"];
  try {
    const { getRecoveryStates } = await import("@/lib/reconcile/recording-recovery");
    let recovering = 0;
    let degraded = 0;
    for (const s of getRecoveryStates().values()) {
      if (s === "recovering") recovering++;
      else degraded++;
    }
    recording = { recovering, degraded };
  } catch {
    // Recovery module unavailable — leave `recording` unset rather than fail the snapshot.
  }

  return {
    takenAt,
    namespaces,
    nim,
    gpus,
    kafka,
    s3,
    cameraSim,
    recording,
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
    log.error("collector threw", { err });
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
    containers: (pod.spec?.containers ?? []).map((c) => c.name),
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
        const cname = c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
        return {
          namespace: svc,
          name: cname,
          phase,
          ready: running ? healthy : succeeded,
          restarts: 0,
          age: c.Status ?? "?",
          containers: [cname],
        };
      });
      return { pods, warnings };
    }

    const namespaces = !nsFilter || nsFilter === "all" ? watchedNamespaces() : [nsFilter];
    const pods: PodSummary[] = [];

    await Promise.allSettled(
      namespaces.map(async (namespace) => {
        try {
          const podItems = await listAllPodsInNs(coreV1(), namespace);
          for (const pod of podItems) {
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
    log.error("pods collector threw", { err });
    warnings.push(`collector threw: ${reason}`);
    return { pods: [], warnings };
  }
}
