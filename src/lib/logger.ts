import "server-only";
import { getRequestId } from "./request-context";
// SECRET_KEY_PATTERN is applied here as well as inside redactAndCap: that
// helper tests key names it encounters *within* an object, so a top-level ctx
// entry — `log.info("x", { password: "hunter2" })` — reaches it as a bare string
// and only the value-shape check would see it.
import { redactAndCap, SECRET_KEY_PATTERN } from "./redact";

type Level = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

function envLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "trace" || raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function isPretty(): boolean {
  if (process.env.LOG_PRETTY === "1") return true;
  if (process.env.LOG_PRETTY === "0") return false;
  return process.env.NODE_ENV !== "production";
}

export interface Logger {
  trace(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(scope: string, ctx?: Record<string, unknown>): Logger;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = { message: err.message, name: err.name };
    if (err.stack) out.stack = err.stack;
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = cause instanceof Error ? serializeError(cause) : cause;
    return out;
  }
  return { value: String(err) };
}

/**
 * Prepares a context object for emission: Errors become plain objects, then
 * everything goes through the shared redaction in [`redact.ts`](./redact.ts).
 *
 * ⚠ **Redaction is a property of this function, not of the call sites.** Before
 * it was here, whether a credential reached stdout depended on every author
 * remembering — and `serializeError` makes that worse rather than better, since
 * it expands an Error into message, stack and cause. Nothing was leaking when
 * this was added (ISVD-550, all 90 call sites checked), which is the point: the
 * next call site is now covered too.
 *
 * Two consequences of reusing the Sentry-side helper, both accepted:
 * strings over `MAX_CONTEXT_STRING_LEN` are truncated — including `err.stack`,
 * which keeps roughly the top 20 frames and bounds the log line — and objects
 * are capped at 50 keys and arrays at 50 items.
 *
 * `msg` is deliberately **not** redacted. It is a developer-written literal at
 * every call site, and the value-shape check only matches a string that *starts*
 * with a credential, so running it over `msg` would risk blanking a whole
 * message while catching almost nothing. Values belong in `ctx`.
 */
function normalizeCtx(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    const serialized = v instanceof Error ? serializeError(v) : v;
    out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redactAndCap(serialized);
  }
  return out;
}

function emit(level: Level, scope: string, baseCtx: Record<string, unknown>, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[envLevel()]) return;

  // baseCtx goes through the same normalization as the call-site ctx. It used to
  // be spread raw, so a credential passed once to `createLogger` or `child`
  // bypassed redaction on every line that logger ever wrote — the widest version
  // of the leak, and the least visible.
  const merged = { ...normalizeCtx(baseCtx), ...normalizeCtx(ctx) };

  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  let reqId: string | undefined;
  try {
    reqId = getRequestId();
  } catch {
    // getRequestId may throw in environments where ALS is unavailable — safe to ignore
  }

  if (isPretty()) {
    const reqIdStr = reqId && !merged.reqId ? ` reqId=${reqId}` : "";
    const ctxStr = Object.keys(merged).length ? " " + JSON.stringify(merged) : "";
    write(`[${level}] [${scope}]${reqIdStr} ${msg}${ctxStr}`);
    return;
  }

  const record = {
    level,
    scope,
    msg,
    time: new Date().toISOString(),
    ...(reqId ? { reqId } : {}),
    ...merged,  // call-site ctx still last to win
  };
  write(JSON.stringify(record));
}

function makeLogger(scope: string, baseCtx: Record<string, unknown>): Logger {
  return {
    trace: (msg, ctx) => emit("trace", scope, baseCtx, msg, ctx),
    debug: (msg, ctx) => emit("debug", scope, baseCtx, msg, ctx),
    info: (msg, ctx) => emit("info", scope, baseCtx, msg, ctx),
    warn: (msg, ctx) => emit("warn", scope, baseCtx, msg, ctx),
    error: (msg, ctx) => emit("error", scope, baseCtx, msg, ctx),
    child: (childScope, childCtx) =>
      makeLogger(`${scope}:${childScope}`, { ...baseCtx, ...(childCtx ?? {}) }),
  };
}

export function createLogger(scope: string, ctx?: Record<string, unknown>): Logger {
  return makeLogger(scope, ctx ?? {});
}

export const log: Logger = makeLogger("console", {});
