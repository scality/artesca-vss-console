// src/lib/streams/sse.ts
// Generic SSE stream factory.
// Handles heartbeat, abort propagation, and clean stream closure.

import { NextResponse } from "next/server";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Creates an SSE response.
 *
 * @param signal  - AbortSignal from the incoming request (`req.signal`).
 * @param onStart - Async producer. Call `write(data, eventName?)` to emit either
 *                  a default `message` event (`data: <json>\n\n`) or a named event
 *                  (`event: <name>\ndata: <json>\n\n`). Named events let the client
 *                  use `EventSource.addEventListener("<name>", ...)`.
 *                  Return void or a cleanup thunk (called on disconnect).
 */
export function createSseResponse<T>(
  signal: AbortSignal,
  onStart: (write: (event: T, eventName?: string) => void) => Promise<void | (() => void)>
): NextResponse {
  const stream = new ReadableStream({
    async start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let cleanup: (() => void) | void;

      const encode = (chunk: string) => {
        try {
          controller.enqueue(new TextEncoder().encode(chunk));
        } catch {
          // Already closed — ignore.
        }
      };

      const write = (event: T, eventName?: string) => {
        if (signal.aborted) return;
        const prefix = eventName ? `event: ${eventName}\n` : "";
        encode(`${prefix}data: ${JSON.stringify(event)}\n\n`);
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

      // Flush an initial comment immediately so the streamed response reaches
      // the client and EventSource fires `open` in milliseconds — without
      // waiting for the producer's first write or the 15 s heartbeat. Next.js
      // does not send the response until the body emits its first chunk.
      encode(": connected\n\n");

      heartbeat = setInterval(() => {
        if (signal.aborted) {
          stop();
          return;
        }
        try {
          encode(": heartbeat\n\n");
        } catch {
          // Controller closed between check and enqueue — ignore.
        }
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
