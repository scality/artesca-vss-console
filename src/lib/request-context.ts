import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  reqId: string;
  // future: userId, traceId, etc.
}

const als = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given reqId visible to any nested code via getRequestContext(). */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** Returns the current request context if running inside runWithRequestContext, else undefined. */
export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

/** Convenience: get just the reqId, or undefined if no context active. */
export function getRequestId(): string | undefined {
  return als.getStore()?.reqId;
}
