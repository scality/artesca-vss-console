// tests/unit/sse.test.ts
// Unit tests for src/lib/streams/sse.ts — createSseResponse factory.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// next/server is not available in the Node test environment.
// Mock it so NextResponse behaves like the real class:
// new NextResponse(body, init) → stores body + init, exposes .body and .headers.
vi.mock("next/server", () => {
  class MockNextResponse {
    body: ReadableStream | null;
    status: number;
    headers: Headers;

    constructor(body: ReadableStream | null, init?: ResponseInit) {
      this.body = body ?? null;
      this.status = init?.status ?? 200;
      this.headers = new Headers(
        init?.headers as Record<string, string> | undefined,
      );
    }
  }

  return { NextResponse: MockNextResponse };
});

import { createSseResponse } from "@/lib/streams/sse";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Drain up to `maxChunks` from a ReadableStream, decoding each as UTF-8 text.
 * Returns all chunks concatenated.  Stops early once `maxChunks` is reached.
 */
async function drainStream(
  stream: ReadableStream<Uint8Array>,
  maxChunks = 20,
): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let result = "";
  let count = 0;
  while (count < maxChunks) {
    const { done, value } = await reader.read();
    if (done) break;
    result += dec.decode(value);
    count++;
  }
  reader.releaseLock();
  return result;
}

// ─── createSseResponse ────────────────────────────────────────────────────────

describe("createSseResponse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 1. Headers ───────────────────────────────────────────────────────────

  it("returns a NextResponse with the required SSE headers", async () => {
    const ctrl = new AbortController();
    const response = createSseResponse(ctrl.signal, async (write) => {
      write({ hello: "world" });
      ctrl.abort();
    });

    // Cast to access the mock class properties
    const res = response as unknown as {
      status: number;
      headers: Headers;
      body: ReadableStream;
    };

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
  });

  // ── 2. Default message event ──────────────────────────────────────────────

  it("write() encodes data as `data: <json>\\n\\n`", async () => {
    const ctrl = new AbortController();
    let capturedChunks = "";

    const response = createSseResponse(ctrl.signal, async (write) => {
      write({ msg: "hello" });
      // abort so the stream closes promptly
      ctrl.abort();
    });

    const body = (
      response as unknown as { body: ReadableStream<Uint8Array> }
    ).body;
    capturedChunks = await drainStream(body);

    expect(capturedChunks).toContain(`data: ${JSON.stringify({ msg: "hello" })}\n\n`);
  });

  // ── 3. Named event ────────────────────────────────────────────────────────

  it("write(payload, eventName) produces `event: <name>\\ndata: <json>\\n\\n`", async () => {
    const ctrl = new AbortController();

    const response = createSseResponse(ctrl.signal, async (write) => {
      write({ severity: "high" }, "alert");
      ctrl.abort();
    });

    const body = (
      response as unknown as { body: ReadableStream<Uint8Array> }
    ).body;
    const chunks = await drainStream(body);

    expect(chunks).toContain(
      `event: alert\ndata: ${JSON.stringify({ severity: "high" })}\n\n`,
    );
  });

  // ── 4. Heartbeat fires every 15 s ─────────────────────────────────────────

  it("heartbeat fires every 15 000 ms and emits `: heartbeat\\n\\n`", async () => {
    const ctrl = new AbortController();
    const encoded: string[] = [];

    const response = createSseResponse(ctrl.signal, async () => {
      // Producer that does nothing — just waits for the heartbeat.
    });

    const body = (
      response as unknown as { body: ReadableStream<Uint8Array> }
    ).body;
    const reader = body.getReader();
    const dec = new TextDecoder();

    // Let the stream start — tick the microtask queue so `start()` executes.
    await Promise.resolve();

    // Advance 15 s to trigger one heartbeat.
    vi.advanceTimersByTime(15_000);

    // Give the timer callback a chance to run.
    await Promise.resolve();

    // Read whatever is available without blocking.
    let done = false;
    let count = 0;
    while (!done && count < 5) {
      const { done: d, value } = await reader.read();
      done = d;
      if (value) encoded.push(dec.decode(value));
      count++;
      if (encoded.some((c) => c.includes(": heartbeat"))) break;
    }

    reader.cancel();
    ctrl.abort();

    expect(encoded.join("")).toContain(": heartbeat\n\n");
  });

  // ── 5. Abort signal tears down the interval ───────────────────────────────

  it("abort signal stops the heartbeat interval and closes the stream", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const ctrl = new AbortController();
    const response = createSseResponse(ctrl.signal, async () => {
      // Producer that does nothing — wait for external abort.
    });

    const body = (
      response as unknown as { body: ReadableStream<Uint8Array> }
    ).body;
    const reader = body.getReader();

    // Let the stream start.
    await Promise.resolve();

    // Abort.
    ctrl.abort();
    await Promise.resolve();

    // The stream should close — drain any buffered chunks (e.g. the initial
    // ": connected" comment) until read() returns done.
    let result = await reader.read();
    while (!result.done) result = await reader.read();
    expect(result.done).toBe(true);

    // clearInterval must have been called (heartbeat cleanup).
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  // ── 6. Heartbeat after abort is swallowed (no throw) ─────────────────────

  it("heartbeat encode after abort does not throw", async () => {
    const ctrl = new AbortController();

    const response = createSseResponse(ctrl.signal, async () => {
      // Producer that does nothing.
    });

    const body = (
      response as unknown as { body: ReadableStream<Uint8Array> }
    ).body;
    // Drain the stream in the background so back-pressure does not stall it.
    void drainStream(body, 100);

    // Let the stream start.
    await Promise.resolve();

    // Abort the controller so the stream is in a closed state.
    ctrl.abort();
    await Promise.resolve();

    // Advance 15 s — the heartbeat timer fires, checks `signal.aborted`, and
    // calls stop() again.  The stop() → controller.close() path wraps in
    // try/catch so re-closing an already-closed controller doesn't throw.
    expect(() => {
      vi.advanceTimersByTime(15_000);
    }).not.toThrow();

    // Flush microtasks.
    await Promise.resolve();
  });
});
