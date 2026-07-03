import "server-only";
import type { CoreV1Api } from "@kubernetes/client-node";
import { promQuery, type PromResult } from "@/lib/helpers/prometheus";
import { coreV1, listAllPodsInNs, watchedNamespaces } from "@/lib/k8s";
import { createLogger } from "@/lib/logger";

const log = createLogger("gpu-allocation");

/** Live health of a GPU pod — surfaces crashloops in the allocation view. */
export interface WorkloadHealth {
  /** Total container restarts (a climbing count == crashlooping). */
  restartCount: number;
  /** All containers report Ready. */
  ready: boolean;
  /** Waiting-state reason of the first not-ready container (e.g.
   *  "CrashLoopBackOff", "ErrImagePull"), or null when healthy. */
  stateReason: string | null;
}

/** NIM container config relevant to GPU placement — surfaced so a crash that
 *  stems from a tensor-parallel/profile mismatch is self-explaining. */
export interface NimConfig {
  /** NIM_TENSOR_PARALLEL_SIZE literal env, or null when unset (NIM auto-picks). */
  tensorParallel: number | null;
  /** NIM_MODEL_PROFILE literal env, or null when unset (NIM auto-selects). */
  modelProfile: string | null;
}

/** A resolved GPU-memory / placement knob, shown so the co-residence budget on
 *  a shared GPU is self-explaining. */
export interface GpuConfigEntry {
  label: string;
  value: string;
}

// Curated env keys that drive GPU memory footprint / placement, with the short
// label shown in the UI. Resolved from literal env AND configMapKeyRef.
const CURATED_GPU_ENV: Array<{ key: string; label: string }> = [
  { key: "NIM_TENSOR_PARALLEL_SIZE", label: "TP" },
  { key: "NIM_MODEL_PROFILE", label: "profile" },
  { key: "NIM_KVCACHE_PERCENT", label: "kv-cache" },
  { key: "NIM_GPU_MEM_FRACTION", label: "gpu-mem" },
  { key: "NIM_MAX_MODEL_LEN", label: "max-len" },
  { key: "NIM_MAX_NUM_SEQS", label: "max-seqs" },
  { key: "VLLM_GPU_MEMORY_UTILIZATION", label: "gpu-mem-util" },
  { key: "VLM_MODEL_TO_USE", label: "model" },
];

/** One workload sharing a GPU, with its VRAM footprint on that device. */
export interface GpuWorkload {
  pod: string;
  namespace: string;
  memUsedMiB: number;
  health?: WorkloadHealth;
  nim?: NimConfig;
  /** Resolved GPU-memory / placement knobs (the co-residence budget). */
  gpuConfig?: GpuConfigEntry[];
}

/** A physical GPU with the workloads currently bound to it. */
export interface GpuAllocation {
  index: number;
  name: string;
  memTotalMiB: number;
  memUsedMiB: number;
  utilGpu: number;
  tempC: number;
  powerW: number;
  workloads: GpuWorkload[];
}

/** A GPU-requesting pod that the scheduler can't place (no free device). */
export interface PendingGpuWorkload {
  pod: string;
  namespace: string;
  gpuRequest: number;
  reason: string;
}

/** A Running pod holding one or more GPUs (K8s scheduler view). */
export interface ScheduledGpuWorkload {
  pod: string;
  namespace: string;
  gpuCount: number;
  health: WorkloadHealth;
  nim?: NimConfig;
  gpuConfig?: GpuConfigEntry[];
}

interface RawEnv {
  name: string;
  value?: string;
  valueFrom?: { configMapKeyRef?: { name?: string; key?: string } };
}

/**
 * Resolve the curated GPU-memory knobs for a pod's containers, reading both
 * literal env and configMapKeyRef values. `cmCache` memoizes ConfigMap fetches
 * within one collection pass. Returns [] when nothing relevant is set.
 */
async function resolveGpuConfig(
  containers: Array<{ env?: RawEnv[] }>,
  namespace: string,
  core: CoreV1Api,
  cmCache: Map<string, Record<string, string> | null>,
): Promise<GpuConfigEntry[]> {
  const byKey = new Map<string, RawEnv>();
  for (const c of containers) {
    for (const e of c.env ?? []) {
      if (!byKey.has(e.name)) byKey.set(e.name, e);
    }
  }

  const getCm = async (name: string): Promise<Record<string, string> | null> => {
    const cacheKey = `${namespace}/${name}`;
    if (cmCache.has(cacheKey)) return cmCache.get(cacheKey) ?? null;
    let data: Record<string, string> | null = null;
    try {
      const cm = await core.readNamespacedConfigMap({ name, namespace });
      data = cm.data ?? {};
    } catch {
      data = null;
    }
    cmCache.set(cacheKey, data);
    return data;
  };

  const entries: GpuConfigEntry[] = [];
  for (const { key, label } of CURATED_GPU_ENV) {
    const e = byKey.get(key);
    if (!e) continue;
    let value: string | undefined = e.value;
    if (value === undefined && e.valueFrom?.configMapKeyRef?.name && e.valueFrom.configMapKeyRef.key) {
      const cm = await getCm(e.valueFrom.configMapKeyRef.name);
      value = cm?.[e.valueFrom.configMapKeyRef.key];
    }
    if (value === undefined || value === "") continue;
    // Truncate long profile hashes for display.
    if (key === "NIM_MODEL_PROFILE" && value.length > 12) value = `${value.slice(0, 12)}…`;
    entries.push({ label, value });
  }
  return entries;
}

/** Extract NIM tensor-parallel + profile from a container's literal env.
 *  Returns null when the container isn't a NIM (no NIM_* env present). */
function nimConfigOf(
  containers: Array<{ image?: string; env?: Array<{ name: string; value?: string }> }>,
): NimConfig | null {
  for (const c of containers) {
    const env = c.env ?? [];
    const isNim = env.some((e) => e.name.startsWith("NIM_")) || /nim/i.test(c.image ?? "");
    if (!isNim) continue;
    const tpRaw = env.find((e) => e.name === "NIM_TENSOR_PARALLEL_SIZE")?.value;
    const profile = env.find((e) => e.name === "NIM_MODEL_PROFILE")?.value ?? null;
    const tp = tpRaw !== undefined ? parseInt(tpRaw, 10) : NaN;
    return {
      tensorParallel: Number.isNaN(tp) ? null : tp,
      modelProfile: profile,
    };
  }
  return null;
}

/** How the node shares each physical GPU across pods. */
export type GpuSharingStrategy = "exclusive" | "time-slicing" | "mps" | "mig" | "unknown";

export interface GpuSharingMode {
  strategy: GpuSharingStrategy;
  /** Physical GPUs on the node (nvidia.com/gpu.count label), or null. */
  physicalGpu: number | null;
  /** Schedulable nvidia.com/gpu units the node advertises (= physical ×
   *  replicas under time-slicing/MPS), or null. */
  schedulableGpu: number | null;
  /** Time-slicing / MPS replica factor per physical GPU, or null. */
  replicas: number | null;
  /** GPU model from nvidia.com/gpu.product, or null. */
  product: string | null;
  /** MIG strategy label (none / single / mixed) when relevant. */
  migStrategy: string | null;
}

/** Live reachability of a remote model endpoint, as the agent would see it. */
export type RemoteModelHealth = "ok" | "bad-url" | "auth-error" | "unreachable" | "unknown";

/** A model the agent uses that is NOT served on a local GPU — e.g. the LLM
 *  offloaded to NVIDIA's hosted API. Surfaced so the per-GPU allocation view
 *  makes "this model isn't on any card, it runs remote" explicit. */
export interface RemoteModel {
  /** "LLM" or "VLM" — which agent role this model fills. */
  role: string;
  /** Model id the agent requests (e.g. nvidia/nvidia-nemotron-nano-9b-v2). */
  name: string;
  /** The remote endpoint host the agent calls (e.g. integrate.api.nvidia.com). */
  endpoint: string;
  /** The full base URL as configured on the agent (LLM_BASE_URL). Shown so a
   *  misconfig like a trailing /v1 is visible (the agent appends /v1 → /v1/v1). */
  baseUrl: string;
  /** The effective OpenAI-compatible API base the agent actually calls
   *  (`{baseUrl}/v1`). This is what to test — the bare host has no web page and
   *  404s in a browser. A misconfig surfaces here as a doubled `/v1/v1`. */
  apiBase: string;
  /** Live health of the endpoint, probed as the agent calls it ({baseUrl}/v1/models). */
  health: RemoteModelHealth;
  /** Human-readable status / fix hint for the health state. */
  detail: string;
}

// Cache the remote-endpoint probe — collectGpuAllocation runs on the overview's
// 5s auto-refresh, but the endpoint is external; probe at most once/minute.
const REMOTE_PROBE_TTL_MS = 60_000;
const remoteProbeCache = new Map<string, { at: number; health: RemoteModelHealth; detail: string }>();

/** Probe a remote LLM endpoint exactly as the agent reaches it: the config
 *  appends /v1 to LLM_BASE_URL and the client hits `{base}/v1/models`. So a
 *  trailing /v1 in LLM_BASE_URL → `…/v1/v1/models` → 404 (the "age not found"
 *  chat bug) is caught here. Keyed on baseUrl; cached for TTL. Never logs/returns the key. */
async function probeRemoteLlm(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<{ health: RemoteModelHealth; detail: string }> {
  const hit = remoteProbeCache.get(baseUrl);
  if (hit && Date.now() - hit.at < REMOTE_PROBE_TTL_MS) return { health: hit.health, detail: hit.detail };

  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  let health: RemoteModelHealth = "unknown";
  let detail = "";
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(4_000), cache: "no-store" });
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    if (resp.status === 200) { health = "ok"; detail = "reachable · model list OK"; }
    else if (resp.status === 401 || resp.status === 403) {
      health = apiKey ? "auth-error" : "ok";
      detail = apiKey ? `auth rejected (HTTP ${resp.status}) — check NVIDIA_API_KEY` : "reachable (auth required)";
    }
    else if (resp.status === 404) { health = "bad-url"; detail = "HTTP 404 — wrong path; check for a trailing /v1 in LLM_BASE_URL"; }
    else { health = "unknown"; detail = `HTTP ${resp.status}`; }
  } catch (e) {
    health = "unreachable";
    detail = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "network error / DNS";
  }
  remoteProbeCache.set(baseUrl, { at: Date.now(), health, detail });
  return { health, detail };
}

export interface GpuAllocationSnapshot {
  gpus: GpuAllocation[];
  pending: PendingGpuWorkload[];
  /** Models served off-cluster (remote LLM/VLM endpoints the agent calls) —
   *  not bound to any local GPU. */
  remoteModels: RemoteModel[];
  /** True when DCGM exposed per-pod labels — false means device-only data. */
  perWorkload: boolean;
  /** Detected GPU sharing strategy + config (from K8s node labels). */
  sharing: GpuSharingMode;
  /** K8s scheduler view — always available (no Prometheus needed). Drives the
   *  off-cluster fallback when DCGM/Prometheus has no per-GPU VRAM data. */
  scheduler: {
    /** Node-allocatable nvidia.com/gpu summed across nodes, or null if unknown. */
    totalGpu: number | null;
    /** GPUs requested by Running GPU pods. */
    allocatedGpu: number;
    workloads: ScheduledGpuWorkload[];
  };
  warnings: string[];
}

function gpuRequestOf(containers: Array<{ resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }>): number {
  return containers.reduce((sum, c) => {
    const req = c.resources?.requests?.["nvidia.com/gpu"];
    const lim = c.resources?.limits?.["nvidia.com/gpu"];
    return sum + (parseInt(String(req ?? lim ?? "0"), 10) || 0);
  }, 0);
}

// DCGM attaches pod attribution under either `pod`/`namespace` or the
// `exported_*` variants depending on the Prometheus relabel config.
function podOf(m: Record<string, string>): string | undefined {
  return m["pod"] || m["exported_pod"] || undefined;
}
function nsOf(m: Record<string, string>): string | undefined {
  return m["namespace"] || m["exported_namespace"] || undefined;
}
function gpuOf(m: Record<string, string>): string {
  return m["gpu"] ?? m["GPU"] ?? "0";
}

/** Device-level value for a GPU (util/temp/power are per-device, not per-pod). */
function deviceVal(results: PromResult[], gpuIdx: string): number {
  const found = results.find((r) => gpuOf(r.metric) === gpuIdx);
  return found ? parseFloat(found.value[1]) || 0 : 0;
}

/** Host of an http(s) URL, or the raw string when it doesn't parse. */
function urlHost(url: string): string {
  const m = /^https?:\/\/([^/:]+)/.exec(url.trim());
  return m ? m[1] : url.trim();
}

/** True when a base URL points off-cluster (public FQDN) rather than at an
 *  in-cluster service (bare name like `vss-rtvi-vlm`, or a `.svc` / `.local`
 *  cluster name). A dotted public host (integrate.api.nvidia.com) is remote. */
function isRemoteUrl(url: string): boolean {
  const host = urlHost(url);
  if (!host || !/^https?:\/\//.test(url.trim())) return false;
  if (!host.includes(".")) return false; // bare cluster service name
  if (host.endsWith(".local") || host.includes(".svc")) return false;
  return true;
}

/** Resolve models the agent uses that are served off-cluster (remote LLM/VLM).
 *  Reads the vss-agent container env (LLM_BASE_URL/LLM_NAME, VLM_BASE_URL/
 *  VLM_NAME); a base URL whose host is a public FQDN means that model runs
 *  remote, not on a local GPU. First agent pod is authoritative. */
async function resolveRemoteModels(
  core: CoreV1Api,
  warnings: string[],
): Promise<RemoteModel[]> {
  const out: RemoteModel[] = [];
  try {
    for (const ns of watchedNamespaces()) {
      const pods = await listAllPodsInNs(core, ns);
      const agent = pods.find((p) => {
        const n = p.metadata?.name ?? "";
        return n.startsWith("vss-agent") && !n.startsWith("vss-agent-ui");
      });
      if (!agent) continue;
      const env = new Map<string, string>();
      for (const c of agent.spec?.containers ?? []) {
        for (const e of c.env ?? []) {
          if (typeof e.value === "string" && !env.has(e.name)) env.set(e.name, e.value);
        }
      }
      const apiKey = env.get("NVIDIA_API_KEY") ?? env.get("OPENAI_API_KEY");
      const roles: Array<[string, string, string]> = [
        ["LLM", env.get("LLM_BASE_URL") ?? "", env.get("LLM_NAME") ?? ""],
        ["VLM", env.get("VLM_BASE_URL") ?? "", env.get("VLM_NAME") ?? ""],
      ];
      for (const [role, url, model] of roles) {
        if (url && isRemoteUrl(url)) {
          const { health, detail } = await probeRemoteLlm(url, apiKey);
          const apiBase = `${url.replace(/\/+$/, "")}/v1`;
          out.push({ role, name: model || "(model)", endpoint: urlHost(url), baseUrl: url, apiBase, health, detail });
        }
      }
      return out;
    }
  } catch (err) {
    log.warn("remote model resolution failed", { err: String(err) });
    warnings.push(`Remote model resolution failed: ${String(err)}`);
  }
  return out;
}

/**
 * Collect how the GPUs are shared across workloads, from DCGM metrics
 * (per-(gpu,pod) framebuffer usage) plus the K8s scheduler view of any
 * GPU-requesting pods that couldn't be placed.
 *
 * Always resolves — Prometheus/K8s failures degrade to warnings + empty data
 * rather than throwing, matching the overview-collector contract.
 */
export async function collectGpuAllocation(): Promise<GpuAllocationSnapshot> {
  const warnings: string[] = [];

  const [fbUsed, fbTotal, util, temp, power] = await Promise.all([
    promQuery("DCGM_FI_DEV_FB_USED"),
    promQuery("DCGM_FI_DEV_FB_TOTAL"),
    promQuery("DCGM_FI_DEV_GPU_UTIL"),
    promQuery("DCGM_FI_DEV_GPU_TEMP"),
    promQuery("DCGM_FI_DEV_POWER_USAGE"),
  ]);
  for (const r of [fbUsed, fbTotal, util, temp, power]) {
    if (r.warning) warnings.push(r.warning);
  }

  // Discover GPU indices + model name from any series.
  const gpuIndices = new Set<string>();
  const nameByGpu = new Map<string, string>();
  for (const r of [fbUsed, fbTotal, util, temp, power]) {
    for (const item of r.results) {
      const g = gpuOf(item.metric);
      gpuIndices.add(g);
      if (item.metric["modelName"] && !nameByGpu.has(g)) {
        nameByGpu.set(g, item.metric["modelName"]);
      }
    }
  }

  let perWorkload = false;
  const gpus: GpuAllocation[] = [];

  for (const gpuIdx of gpuIndices) {
    // Per-pod framebuffer series for this GPU → workloads sharing it.
    const workloads: GpuWorkload[] = [];
    for (const item of fbUsed.results) {
      if (gpuOf(item.metric) !== gpuIdx) continue;
      const pod = podOf(item.metric);
      const namespace = nsOf(item.metric);
      if (!pod || !namespace) continue;
      perWorkload = true;
      workloads.push({
        pod,
        namespace,
        memUsedMiB: parseFloat(item.value[1]) || 0,
      });
    }
    workloads.sort((a, b) => b.memUsedMiB - a.memUsedMiB);

    const memTotalMiB = deviceVal(fbTotal.results, gpuIdx) || 1;
    // Prefer the device-total FB_USED (a series may carry no pod label); fall
    // back to summing the per-pod series.
    const deviceUsed = deviceVal(fbUsed.results, gpuIdx);
    const memUsedMiB =
      deviceUsed || workloads.reduce((s, w) => s + w.memUsedMiB, 0);

    gpus.push({
      index: parseInt(gpuIdx, 10) || 0,
      name: nameByGpu.get(gpuIdx) ?? `GPU ${gpuIdx}`,
      memTotalMiB,
      memUsedMiB,
      utilGpu: deviceVal(util.results, gpuIdx),
      tempC: deviceVal(temp.results, gpuIdx),
      powerW: deviceVal(power.results, gpuIdx),
      workloads,
    });
  }
  gpus.sort((a, b) => a.index - b.index);

  // K8s scheduler view (no Prometheus needed): node GPU capacity, the Running
  // pods holding GPUs, and any GPU-requesting pods the scheduler couldn't place
  // (the over-subscription case — more GPU workloads than devices).
  const pending: PendingGpuWorkload[] = [];
  const scheduledWorkloads: ScheduledGpuWorkload[] = [];
  let allocatedGpu = 0;
  let totalGpu: number | null = null;

  const sharing: GpuSharingMode = {
    strategy: "unknown",
    physicalGpu: null,
    schedulableGpu: null,
    replicas: null,
    product: null,
    migStrategy: null,
  };

  const core = coreV1();
  try {
    const nodes = await core.listNode();
    let sum = 0;
    let sawGpuNode = false;
    let sawMig = false;
    for (const n of nodes.items ?? []) {
      const alloc = n.status?.allocatable ?? {};
      const labels = n.metadata?.labels ?? {};
      const gpuAlloc = alloc["nvidia.com/gpu"];
      // MIG advertises nvidia.com/mig-<profile> resources instead of/alongside gpu.
      const migKeys = Object.keys(alloc).filter((k) => k.startsWith("nvidia.com/mig-"));
      if (migKeys.length > 0) sawMig = true;
      if (gpuAlloc === undefined && migKeys.length === 0) continue;
      sawGpuNode = true;
      sum += parseInt(String(gpuAlloc ?? "0"), 10) || 0;

      // GPU Feature Discovery / device-plugin labels carry the sharing config.
      const strat = labels["nvidia.com/gpu.sharing-strategy"];
      const replicas = parseInt(labels["nvidia.com/gpu.replicas"] ?? "", 10);
      const physical = parseInt(labels["nvidia.com/gpu.count"] ?? "", 10);
      if (!isNaN(physical)) sharing.physicalGpu = (sharing.physicalGpu ?? 0) + physical;
      if (!isNaN(replicas) && replicas > 0) sharing.replicas = replicas;
      if (labels["nvidia.com/gpu.product"]) sharing.product = labels["nvidia.com/gpu.product"];
      if (labels["nvidia.com/mig.strategy"]) sharing.migStrategy = labels["nvidia.com/mig.strategy"];
      if (strat === "mps") sharing.strategy = "mps";
      else if (strat === "time-slicing") sharing.strategy = "time-slicing";
    }
    if (sawGpuNode) {
      totalGpu = sum;
      sharing.schedulableGpu = sum;
    }
    // Resolve the strategy when GFD didn't label it explicitly.
    if (sawMig) {
      sharing.strategy = "mig";
    } else if (sharing.strategy === "unknown" && sawGpuNode) {
      const phys = sharing.physicalGpu;
      if ((sharing.replicas ?? 1) > 1 || (phys !== null && totalGpu !== null && totalGpu > phys)) {
        sharing.strategy = "time-slicing";
      } else {
        sharing.strategy = "exclusive";
      }
    }
    // Infer replicas from the allocatable/physical ratio when unlabelled.
    if (sharing.replicas === null && sharing.physicalGpu && totalGpu && sharing.physicalGpu > 0) {
      const ratio = totalGpu / sharing.physicalGpu;
      if (Number.isInteger(ratio) && ratio > 1) sharing.replicas = ratio;
    }
  } catch (err) {
    log.warn("node GPU capacity unavailable", { err: String(err) });
    warnings.push(`Node GPU capacity unavailable: ${String(err)}`);
  }

  // pod name → live health / NIM config / GPU-memory knobs, so DCGM-sourced
  // workloads can be enriched too.
  const healthByPod = new Map<string, WorkloadHealth>();
  const nimByPod = new Map<string, NimConfig>();
  const cfgByPod = new Map<string, GpuConfigEntry[]>();
  const cmCache = new Map<string, Record<string, string> | null>();
  try {
    for (const ns of watchedNamespaces()) {
      const pods = await listAllPodsInNs(core, ns);
      for (const p of pods) {
        const containers = p.spec?.containers ?? [];
        const gpuReq = gpuRequestOf(containers);
        if (gpuReq <= 0) continue;
        const name = p.metadata?.name ?? "(unknown)";
        const phase = p.status?.phase;

        const statuses = p.status?.containerStatuses ?? [];
        const restartCount = statuses.reduce((s, c) => s + (c.restartCount ?? 0), 0);
        const ready = statuses.length > 0 && statuses.every((c) => c.ready);
        const waiting = statuses.find((c) => c.state?.waiting?.reason)?.state?.waiting?.reason;
        const health: WorkloadHealth = {
          restartCount,
          ready,
          stateReason: waiting ?? (phase === "Failed" ? "Failed" : null),
        };
        healthByPod.set(name, health);
        const nim = nimConfigOf(containers);
        if (nim) nimByPod.set(name, nim);
        const gpuConfig = await resolveGpuConfig(containers, ns, core, cmCache);
        if (gpuConfig.length > 0) cfgByPod.set(name, gpuConfig);

        if (phase === "Pending") {
          const unsched = p.status?.conditions?.find(
            (c) => c.type === "PodScheduled" && c.status === "False"
          );
          pending.push({
            pod: name,
            namespace: ns,
            gpuRequest: gpuReq,
            reason: unsched?.message ?? unsched?.reason ?? "Pending",
          });
        } else if (phase === "Running") {
          allocatedGpu += gpuReq;
          scheduledWorkloads.push({
            pod: name,
            namespace: ns,
            gpuCount: gpuReq,
            health,
            ...(nim ? { nim } : {}),
            ...(gpuConfig.length > 0 ? { gpuConfig } : {}),
          });
        }
      }
    }
    // Enrich DCGM per-pod workloads with the same health / NIM / config.
    for (const g of gpus) {
      for (const w of g.workloads) {
        const h = healthByPod.get(w.pod);
        if (h) w.health = h;
        const n = nimByPod.get(w.pod);
        if (n) w.nim = n;
        const cfg = cfgByPod.get(w.pod);
        if (cfg) w.gpuConfig = cfg;
      }
    }
  } catch (err) {
    log.warn("GPU pods unavailable", { err: String(err) });
    warnings.push(`GPU pods unavailable: ${String(err)}`);
  }
  scheduledWorkloads.sort((a, b) => b.gpuCount - a.gpuCount);

  const remoteModels = await resolveRemoteModels(core, warnings);

  return {
    gpus,
    pending,
    remoteModels,
    perWorkload,
    sharing,
    scheduler: { totalGpu, allocatedGpu, workloads: scheduledWorkloads },
    warnings,
  };
}
