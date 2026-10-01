// The box's GPU mode, read from the AI Factory's record, and the pause guard
// that follows from it.
//
// A box can run a second app, the AI Factory, whose GPU switch moves the whole
// box between two profiles: `vss` (this console's world) and `llm` (the VSS GPU
// workloads scaled to 0, vLLM on the GPUs). It records the active profile in
// one ConfigMap (CLUSTER.aiFactory: `ai-factory/gpu-mode`, keys `mode`,
// `pinned`, `updatedAt`, …) and is that record's only writer.
//
// While the mode is not `vss`, the console must not write the workloads the
// switch scales — a rollout restart or an env patch on a parked workload is
// drift the switch then measures and has to undo, and a restart of a workload
// the switch is bringing back races it. So every writer of those workloads asks
// this module first: the reconcile loop skips them (one log line per cycle) and
// the routes answer 409. Reads are never paused, and nothing here is sticky —
// the guard re-reads the record (cached ~10 s) on every write, so writes resume
// on their own once the mode is `vss` again.
//
// No record means `vss`. A box without the AI Factory has no `ai-factory`
// namespace, and the console must behave there exactly as it does without this
// module. A record the console cannot read (403, timeout) or cannot parse also
// reads as `vss`, with `source: "error"` and the cause in `reason` — failing
// open, because failing closed would freeze every VSS box whose RBAC lacks the
// read.

import "server-only";
import { NextResponse } from "next/server";
import { CLUSTER } from "@/lib/cluster-refs";
import { createLogger } from "@/lib/logger";
import { DEFAULT_BOX_MODE, isBoxPaused, pausedHeadline, type BoxMode } from "@/lib/box-mode-shared";

export type { BoxMode, BoxModeSource } from "@/lib/box-mode-shared";
export { isBoxPaused, pausedHeadline } from "@/lib/box-mode-shared";

const log = createLogger("box-mode");

/** How long a read is reused. The switch takes minutes; 10 s of lag is nothing
 *  against it, and it keeps the guard from reading the API on every write. */
export const BOX_MODE_TTL_MS = 10_000;
/** A read that has not answered by then counts as an error (→ `vss`). */
export const BOX_MODE_READ_TIMEOUT_MS = 3_000;

// ─── the record ──────────────────────────────────────────────────────────────

export function modeRecordRef(): { namespace: string; name: string } {
  // Optional chaining: a test that mocks cluster-refs with a partial CLUSTER
  // must still get a reader, not a TypeError at import or call time.
  const af = (CLUSTER as { aiFactory?: { modeNamespace?: string; modeConfigMap?: string } } | undefined)?.aiFactory;
  return { namespace: af?.modeNamespace ?? "ai-factory", name: af?.modeConfigMap ?? "gpu-mode" };
}

/** Reads one ConfigMap. Resolves to the object (anything with `data`), or
 *  `null` for "not there"; rejects with the API error otherwise. */
export type ConfigMapReader = (namespace: string, name: string) => Promise<unknown>;

async function k8sReadConfigMap(namespace: string, name: string): Promise<unknown> {
  // Imported lazily: k8s.ts imports this module for the write guard.
  const { coreV1 } = await import("@/lib/k8s");
  return coreV1().readNamespacedConfigMap({ name, namespace });
}

const MODE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const fallback = (source: "absent" | "error", reason: string): BoxMode => ({
  mode: DEFAULT_BOX_MODE,
  pinned: false,
  updatedAt: null,
  source,
  reason,
});

/** Parse what the API returned for the record. Pure. */
export function parseModeRecord(cm: unknown, ref = "ai-factory/gpu-mode"): BoxMode {
  if (cm === null || cm === undefined) {
    return fallback("absent", `ConfigMap ${ref} not found — no AI Factory on this box`);
  }
  const data = (cm as { data?: unknown }).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return fallback("error", `malformed: ConfigMap ${ref} has no data`);
  }
  const d = data as Record<string, unknown>;
  if (typeof d.mode !== "string" || d.mode.trim() === "") {
    return fallback("error", `malformed: ConfigMap ${ref} has no 'mode' key`);
  }
  const mode = d.mode.trim().toLowerCase();
  if (!MODE_NAME.test(mode)) {
    return fallback("error", `malformed: ConfigMap ${ref} 'mode' is ${JSON.stringify(d.mode.slice(0, 40))}, not a mode name`);
  }
  const updatedAt = typeof d.updatedAt === "string" && d.updatedAt.trim() ? d.updatedAt.trim() : null;
  return { mode, pinned: d.pinned === "true", updatedAt, source: "configmap", reason: null };
}

/** Map a failed read to a mode. Pure. 404 is a box without the AI Factory
 *  (namespace or ConfigMap missing); everything else is an error. */
export function modeFromReadError(err: unknown, ref = "ai-factory/gpu-mode"): BoxMode {
  const e = (err ?? {}) as { code?: unknown; statusCode?: unknown; response?: { statusCode?: unknown }; message?: unknown };
  const status = [e.code, e.statusCode, e.response?.statusCode].find((v): v is number => typeof v === "number");
  if (status === 404) return fallback("absent", `ConfigMap ${ref} not found — no AI Factory on this box`);
  if (status === 403) {
    return fallback("error", `forbidden: the console's ServiceAccount cannot get ConfigMap ${ref}`);
  }
  const msg = err instanceof Error ? err.message : typeof e.message === "string" ? e.message : String(err);
  return fallback("error", `could not read ConfigMap ${ref}: ${msg.slice(0, 200)}`);
}

/** One uncached read. Never throws. */
export async function readBoxMode(
  opts: { reader?: ConfigMapReader; timeoutMs?: number } = {},
): Promise<BoxMode> {
  const { namespace, name } = modeRecordRef();
  const ref = `${namespace}/${name}`;
  const timeoutMs = opts.timeoutMs ?? BOX_MODE_READ_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (opts.reader ?? k8sReadConfigMap)(namespace, name);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    return parseModeRecord(await Promise.race([read, timeout]), ref);
  } catch (err) {
    return modeFromReadError(err, ref);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── the cached read ─────────────────────────────────────────────────────────

let cached: { at: number; value: BoxMode } | null = null;
let inflight: Promise<BoxMode> | null = null;
let lastNoted: string | null = null;
let reader: ConfigMapReader | undefined;

/** Log a change of mode or source once, not on every read. */
function noteTransition(m: BoxMode): void {
  const key = `${m.source}:${m.mode}`;
  if (key === lastNoted) return;
  lastNoted = key;
  if (m.source === "error") {
    log.warn(`box mode unreadable — assuming ${m.mode}`, { reason: m.reason });
  } else if (isBoxPaused(m)) {
    log.info(`box mode ${m.mode} — writes to the AI Factory's GPU workloads paused`, {
      pinned: m.pinned,
      updatedAt: m.updatedAt,
    });
  } else {
    log.info(`box mode ${m.mode} (${m.source})`, m.reason ? { reason: m.reason } : undefined);
  }
}

/** The box's mode, cached for BOX_MODE_TTL_MS. Concurrent callers share one
 *  read. Never throws. */
export async function getBoxMode(now: () => number = Date.now): Promise<BoxMode> {
  if (cached && now() - cached.at < BOX_MODE_TTL_MS) return cached.value;
  if (inflight) return inflight;
  const p = readBoxMode({ reader })
    .then((value) => {
      cached = { at: now(), value };
      noteTransition(value);
      return value;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** Tests: drop the cache and, optionally, replace the API read. */
export function resetBoxModeCache(opts: { reader?: ConfigMapReader } = {}): void {
  cached = null;
  inflight = null;
  lastNoted = null;
  reader = opts.reader;
}

// ─── the workloads the switch owns ───────────────────────────────────────────

export interface WorkloadRef {
  kind: "Deployment" | "StatefulSet";
  namespace: string;
  name: string;
}

/**
 * The workloads the AI Factory's GPU switch scales to 0 in `llm` mode, in this
 * console's names: the VLM Deployment, the VST recorder, and the KV-cache demo's
 * vLLM. Derived from CLUSTER so an operator override (VSS_NAMESPACE, …) moves
 * them together with everything else.
 */
export function switchOwnedWorkloads(): WorkloadRef[] {
  const c = (CLUSTER ?? {}) as {
    rtvi?: { vlmNamespace?: string; vlmDeployment?: string };
    vst?: { namespace?: string; streamProcessingDeployment?: string; streamProcessingKind?: WorkloadRef["kind"] };
    kvcache?: { vllmNamespace?: string; vllmDeployment?: string };
  };
  const out: WorkloadRef[] = [];
  if (c.rtvi?.vlmNamespace && c.rtvi.vlmDeployment) {
    out.push({ kind: "Deployment", namespace: c.rtvi.vlmNamespace, name: c.rtvi.vlmDeployment });
  }
  if (c.vst?.namespace && c.vst.streamProcessingDeployment) {
    out.push({
      kind: c.vst.streamProcessingKind ?? "StatefulSet",
      namespace: c.vst.namespace,
      name: c.vst.streamProcessingDeployment,
    });
  }
  if (c.kvcache?.vllmNamespace && c.kvcache.vllmDeployment) {
    out.push({ kind: "Deployment", namespace: c.kvcache.vllmNamespace, name: c.kvcache.vllmDeployment });
  }
  return out;
}

/** Same namespace and name as a switch-owned workload. Kind is not compared:
 *  a name the switch scales is the switch's whichever API wrote it. */
export function isSwitchOwned(namespace: string, name: string): boolean {
  return switchOwnedWorkloads().some((w) => w.namespace === namespace && w.name === name);
}

const workloadLabel = (w: WorkloadRef) => `${w.kind.toLowerCase()}/${w.namespace}/${w.name}`;

/** Thrown by a guarded write while the box is not in `vss` mode. */
export class BoxPausedError extends Error {
  readonly status = 409;
  constructor(
    readonly boxMode: BoxMode,
    readonly workloads: WorkloadRef[],
  ) {
    const names = workloads.map(workloadLabel).join(", ");
    const one = workloads.length === 1;
    super(
      `${pausedHeadline(boxMode.mode)}. ${names} ${one ? "is" : "are"} scaled by the AI Factory GPU switch, ` +
        `so the console does not write ${one ? "it" : "them"} until the box is back in 'vss' mode` +
        `${boxMode.pinned ? " (the box is pinned to this mode)" : ""}.`,
    );
    this.name = "BoxPausedError";
  }
}

export function isBoxPausedError(err: unknown): err is BoxPausedError {
  return err instanceof BoxPausedError || (err as { name?: unknown } | null)?.name === "BoxPausedError";
}

/**
 * The write guard. Throws BoxPausedError when the workload is one the switch
 * owns and the box is not in `vss` mode; otherwise returns. Anything the switch
 * does not own returns without reading the record.
 */
export async function assertWorkloadWritable(
  kind: WorkloadRef["kind"],
  namespace: string,
  name: string,
): Promise<void> {
  if (!isSwitchOwned(namespace, name)) return;
  const m = await getBoxMode();
  if (isBoxPaused(m)) throw new BoxPausedError(m, [{ kind, namespace, name }]);
}

/**
 * For routes, before their first write: a 409 when any of `workloads` is one
 * the switch owns and the box is not in `vss` mode, else null. Checking up
 * front keeps a save from half-applying — patching a ConfigMap and then being
 * refused the restart that makes it take effect.
 */
export async function boxPausedResponse(workloads: WorkloadRef[]): Promise<NextResponse | null> {
  const owned = workloads.filter((w) => isSwitchOwned(w.namespace, w.name));
  if (owned.length === 0) return null;
  const m = await getBoxMode();
  if (!isBoxPaused(m)) return null;
  return boxPausedErrorResponse(new BoxPausedError(m, owned));
}

export function boxPausedErrorResponse(err: BoxPausedError): NextResponse {
  return NextResponse.json(
    {
      error: err.message,
      paused: true,
      boxMode: err.boxMode,
      workloads: err.workloads,
      aiFactoryUrl: (CLUSTER as { aiFactory?: { url?: string } } | undefined)?.aiFactory?.url ?? null,
    },
    { status: 409 },
  );
}

/** The reconcile loop's one line per paused cycle. */
export function reconcilePausedLine(m: BoxMode): string {
  return (
    `paused: box in ${m.mode} mode — VLM prompt/strategy and recording-recovery writes skipped ` +
    `until it is back in vss (cameras and scenarios still converge)`
  );
}
