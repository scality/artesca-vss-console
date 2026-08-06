/**
 * Drop two specific Node warnings that come from dependencies we cannot bump,
 * where the warning describes the dependency's behaviour rather than ours.
 *
 * Both are matched narrowly. Everything else passes through untouched — the
 * point of this module is to keep the pod log worth reading, not to quieten it.
 *
 * DEP0169 (`url.parse()`)
 *   @kubernetes/client-node's fetch client (IsomorphicFetchHttpLibrary) is backed
 *   by node-fetch@2, whose Request constructor calls the legacy url.parse(). It
 *   fires on every k8s API call (e.g. listAllPodsInNs behind the overview page and
 *   its 5 s auto-refresh). The package is already at its latest release (1.4.0) and
 *   still pins node-fetch@^2, so there is no upstream-clean version to bump to.
 *
 * TimeoutNegativeWarning, epoch-magnitude only
 *   kafkajs 2.2.4 initialises `throttledUntil = -1` and then computes
 *   `scheduleAt = this.throttledUntil - Date.now()` in
 *   requestQueue.scheduleCheckPendingRequests(). The clamp that would make that
 *   positive only applies when the pending queue is non-empty, so on a quiet
 *   queue the negative goes straight to setTimeout. Node clamps it to 1 ms and
 *   warns, once per request queue — i.e. on every pod start. The effect is that
 *   checkPendingRequests() runs 1 ms later against an empty queue: a no-op, which
 *   is why nothing downstream was ever attributable to it (ISVD-594). 2.2.4 is the
 *   latest stable release, so again there is nothing to bump to.
 *
 *   Only epoch-magnitude values are dropped. A negative timeout we introduce
 *   ourselves would be small — an off-by-one, a subtraction of two durations — and
 *   must still be seen. Only `X - Date.now()` with X near zero lands below
 *   -1e12, and that shape cannot be an intended delay.
 *
 * Lives in its own module so the Node-only `process.emitWarning` patch is pulled
 * in via dynamic import from instrumentation's nodejs branch and never lands in
 * the Edge runtime bundle.
 */

const globalForFilter = globalThis as unknown as { __upstreamWarningsFiltered?: boolean };

/** Below this, a negative setTimeout delay can only be `X - Date.now()`. */
const EPOCH_MAGNITUDE = -1e12;

/** Node passes (warning, type, code) or (warning, { type, code }). */
function warningMeta(rest: unknown[]): { type?: string; code?: string } {
  if (typeof rest[0] === "object" && rest[0] !== null) {
    const o = rest[0] as { type?: string; code?: string };
    return { type: o.type, code: o.code };
  }
  return {
    type: typeof rest[0] === "string" ? rest[0] : undefined,
    code: typeof rest[1] === "string" ? rest[1] : undefined,
  };
}

/** True for kafkajs's `throttledUntil - Date.now()`, not for a small mistake. */
export function isEpochScaleNegativeTimeout(
  type: string | undefined,
  warning: unknown,
): boolean {
  if (type !== "TimeoutNegativeWarning") return false;
  const text = warning instanceof Error ? warning.message : String(warning);
  const m = text.match(/-\d{13,}/);
  if (!m) return false;
  return Number(m[0]) < EPOCH_MAGNITUDE;
}

export function filterKnownUpstreamWarnings(): void {
  if (globalForFilter.__upstreamWarningsFiltered) return;
  globalForFilter.__upstreamWarningsFiltered = true;

  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const { type, code } = warningMeta(rest);
    if (code === "DEP0169") return;
    if (isEpochScaleNegativeTimeout(type, warning)) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
