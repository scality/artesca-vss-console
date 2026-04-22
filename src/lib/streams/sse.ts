// src/lib/streams/sse.ts
// Generic SSE stream factory.
// Handles heartbeat, abort propagation, and clean stream closure.

import { NextResponse } from "next/server";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Creates an SSE response.
 *
 * @param signal  - AbortSignal from the incoming request (`req.signal`).
 * @param onStart - Async producer. Call `write(data)` to emit `data: <json>\n\n`.
 *                  Return void or a cleanup thunk (called on disconnect).
 */
export function createSseResponse<T>(
  signal: AbortSignal,
  onStart: (write: (event: T) => void) => Promise<void | (() => void)>
): NextResponse {
  const stream = new ReadableStream({
    async start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let cleanup: (() => void) | void;

      const encode = (chunk: string) =>
        controller.enqueue(new TextEncoder().encode(chunk));

      const write = (event: T) => {
        if (signal.aborted) return;
        encode(`data: ${JSON.stringify(event)}\n\n`);
      };

      const stop = () => {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (typeof cleanup === "function") cleanup();
        try {
          controller.close();
        } catch {
          // Already closed — ignore.
        }
      };

      signal.addEventListener("abort", stop, { once: true });

      heartbeat = setInterval(() => {
        if (signal.aborted) {
          stop();
          return;
        }
        encode(": heartbeat\n\n");
      }, HEARTBEAT_INTERVAL_MS);

      try {
        cleanup = await onStart(write);
      } catch (err) {
        // Emit error event then close.
        if (!signal.aborted) {
          encode(
            `data: ${JSON.stringify({ error: String(err) })}\n\n`
          );
        }
        stop();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
