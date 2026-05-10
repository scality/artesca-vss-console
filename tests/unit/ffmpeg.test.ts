// tests/unit/ffmpeg.test.ts
// Unit tests for src/lib/streams/ffmpeg.ts — bounded concurrency ffmpeg pool.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ─── Mock child_process ───────────────────────────────────────────────────────
//
// Vitest hoists vi.mock() to the top of the file before any imports.
// The module-level `spawnMock` variable is shared with the factory closure so
// tests can set `spawnMock.mockReturnValue(...)` and the mock module picks it up.

const spawnMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a fake child-process with stderr + stdout EventEmitters.
 * Tests emit "close" or "error" on this object to drive spawnFfmpeg.
 */
function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
    stdin: null;
  };
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdin = null;
  return proc;
}

/**
 * Drain the microtask queue enough for `await acquire()` inside spawnFfmpeg
 * to resolve and for `child_process.spawn` to be called.
 */
async function drainMicrotasks(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
//
// Clear the globalThis pool so every test starts with activeCount=0 / queue=[].
// vi.resetModules() ensures a fresh ffmpeg module (and therefore a fresh pool
// reference on globalThis.__consoleFfmpegQueue) each time.

beforeEach(() => {
  (globalThis as Record<string, unknown>).__consoleFfmpegQueue = undefined;
  vi.resetModules();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── spawnFfmpeg ──────────────────────────────────────────────────────────────

describe("spawnFfmpeg", () => {
  // ── 1. Happy path ─────────────────────────────────────────────────────────

  it("calls spawn with 'ffmpeg' and the provided args", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const { spawnFfmpeg } = await import("@/lib/streams/ffmpeg");

    const argsIn = ["-i", "input.mp4", "output.m3u8"];
    const promise = spawnFfmpeg(argsIn);

    // Let `await acquire()` settle before emitting close.
    await drainMicrotasks();
    fakeProc.emit("close", 0);

    const result = await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      "ffmpeg",
      argsIn,
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(result.code).toBe(0);
  });

  // ── 2. Stderr collection ──────────────────────────────────────────────────

  it("collects stderr chunks into the result", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const { spawnFfmpeg } = await import("@/lib/streams/ffmpeg");

    const promise = spawnFfmpeg(["-version"]);

    await drainMicrotasks();
    fakeProc.stderr.emit("data", Buffer.from("ffmpeg version 6.1"));
    fakeProc.stderr.emit("data", Buffer.from(" built with gcc"));
    fakeProc.emit("close", 0);

    const result = await promise;
    expect(result.stderr).toBe("ffmpeg version 6.1 built with gcc");
  });

  // ── 3. Non-zero exit code ─────────────────────────────────────────────────

  it("resolves with the non-zero exit code and captured stderr", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const { spawnFfmpeg } = await import("@/lib/streams/ffmpeg");

    const promise = spawnFfmpeg(["-i", "bad.mp4"]);

    await drainMicrotasks();
    fakeProc.stderr.emit("data", Buffer.from("Invalid data found"));
    fakeProc.emit("close", 1);

    const result = await promise;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid data found");
  });

  // ── 4. ENOENT → friendly rejection ───────────────────────────────────────

  it("rejects with a friendly error when ffmpeg binary is not found (ENOENT)", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const { spawnFfmpeg } = await import("@/lib/streams/ffmpeg");

    const promise = spawnFfmpeg(["-i", "input.mp4"]);

    await drainMicrotasks();
    const enoentErr = Object.assign(new Error("spawn ffmpeg ENOENT"), {
      code: "ENOENT",
    });
    fakeProc.emit("error", enoentErr);

    await expect(promise).rejects.toThrow("ffmpeg binary not found");
  });

  // ── 5. Concurrency limit ──────────────────────────────────────────────────

  it("queues the 3rd call until one of the first two finishes", async () => {
    const procs = [makeFakeProc(), makeFakeProc(), makeFakeProc()];
    let spawnCallCount = 0;
    spawnMock.mockImplementation(() => procs[spawnCallCount++]);

    const { spawnFfmpeg } = await import("@/lib/streams/ffmpeg");

    // First two acquire slots immediately.
    const p1 = spawnFfmpeg(["-i", "a.mp4"]);
    const p2 = spawnFfmpeg(["-i", "b.mp4"]);

    await drainMicrotasks(4);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Third call is queued — cannot spawn yet.
    const p3 = spawnFfmpeg(["-i", "c.mp4"]);
    await drainMicrotasks(4);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Release a slot by finishing p1 → queue resolves → p3 spawns.
    procs[0].emit("close", 0);
    await drainMicrotasks(6);
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // Clean up remaining processes.
    procs[1].emit("close", 0);
    procs[2].emit("close", 0);
    await Promise.all([p1, p2, p3]);
  });

  // ── 6. globalThis pool is isolated per test ───────────────────────────────

  it("pool starts at activeCount=0 because beforeEach cleared globalThis", async () => {
    const fakeProc = makeFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const { spawnFfmpeg } = await import("@/lib/streams/ffmpeg");

    const pool = (
      globalThis as unknown as Record<string, { activeCount: number; queue: unknown[] }>
    ).__consoleFfmpegQueue;

    expect(pool.activeCount).toBe(0);
    expect(pool.queue).toHaveLength(0);

    // One in-flight call increments activeCount.
    const promise = spawnFfmpeg(["-i", "test.mp4"]);
    await drainMicrotasks();

    expect(pool.activeCount).toBe(1);

    // Cleanup.
    fakeProc.emit("close", 0);
    await promise;
  });
});
