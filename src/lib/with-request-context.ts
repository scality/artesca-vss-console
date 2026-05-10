import "server-only";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { runWithRequestContext } from "./request-context";

/**
 * Wraps a route-handler-ish function so its body runs inside a request context.
 * Reads x-request-id from the request headers (set by middleware), falling back
 * to a fresh UUID if absent (e.g. in unit tests or direct invocation).
 *
 * Usage:
 *   export const POST = withRequestContext(async (req) => {
 *     // ...handler body — log calls inside here include reqId
 *   });
 */
export function withRequestContext<Args extends unknown[], R>(
  handler: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    let reqId: string;
    try {
      const h = await headers();
      reqId = h.get("x-request-id") ?? randomUUID();
    } catch {
      reqId = randomUUID();
    }
    return runWithRequestContext({ reqId }, () => Promise.resolve(handler(...args)));
  };
}
