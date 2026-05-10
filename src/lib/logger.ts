import "server-only";

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

function normalizeCtx(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    out[k] = v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

function emit(level: Level, scope: string, baseCtx: Record<string, unknown>, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[envLevel()]) return;

  const merged = { ...baseCtx, ...normalizeCtx(ctx) };

  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;

  if (isPretty()) {
    const ctxStr = Object.keys(merged).length ? " " + JSON.stringify(merged) : "";
    stream.write(`[${level}] [${scope}] ${msg}${ctxStr}\n`);
    return;
  }

  const record = {
    level,
    scope,
    msg,
    time: new Date().toISOString(),
    ...merged,
  };
  stream.write(JSON.stringify(record) + "\n");
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
