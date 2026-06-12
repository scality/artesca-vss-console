import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("@/lib/logger", () => {
  const makeLogger = (): Record<string, unknown> => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => makeLogger(),
  });
  return { createLogger: () => makeLogger(), log: makeLogger() };
});

// Each test gets a fresh module graph (clears the module-scoped _intervalHandle)
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Advance time by `ms` and drain any queued microtasks/promises. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** One poll cycle = 6 s */
const CYCLE = 6_000;

// ─── lifecycle ────────────────────────────────────────────────────────────────

describe("caption bridge — interval lifecycle", () => {
  it("stopCaptionBridge clears the interval and is idempotent", async () => {
    vi.stubEnv("RTVI_VLM_URL", "http://127.0.0.1:9999");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200 }));

    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const { startCaptionBridge, stopCaptionBridge } = await import(
      "@/lib/caption-bridge"
    );

    startCaptionBridge();
    await advance(CYCLE);

    expect(() => stopCaptionBridge()).not.toThrow();
    expect(clearSpy).toHaveBeenCalled();

    // Second call must not throw
    expect(() => stopCaptionBridge()).not.toThrow();

    fetchSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it("returned stop function is the same as stopCaptionBridge", async () => {
    vi.stubEnv("RTVI_VLM_URL", "http://127.0.0.1:9999");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200 }));

    const { startCaptionBridge, stopCaptionBridge } = await import(
      "@/lib/caption-bridge"
    );

    const stop = startCaptionBridge();

    // After calling the returned stop(), stopCaptionBridge() is also a no-op
    stop();
    expect(() => stopCaptionBridge()).not.toThrow();

    fetchSpy.mockRestore();
  });

  it("duplicate startCaptionBridge calls do not register a second interval", async () => {
    vi.stubEnv("RTVI_VLM_URL", "http://127.0.0.1:9999");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200 }));

    const { startCaptionBridge, stopCaptionBridge } = await import(
      "@/lib/caption-bridge"
    );

    startCaptionBridge(); // first — registers interval

    const setSpy = vi.spyOn(globalThis, "setInterval");
    startCaptionBridge(); // duplicate — should NOT call setInterval again
    expect(setSpy).not.toHaveBeenCalled();

    stopCaptionBridge();
    setSpy.mockRestore();
    fetchSpy.mockRestore();
  });
});

// ─── backoff ──────────────────────────────────────────────────────────────────

describe("caption bridge — backoff on repeated failures", () => {
  it("reschedules with a longer interval after MAX_FAST_FAILURES (3) failures", async () => {
    vi.stubEnv("RTVI_VLM_URL", "http://127.0.0.1:9999");

    // stream-info succeeds; caption endpoint always rejects
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("get-stream-info")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ id: "s1" }]), { status: 200 })
        );
      }
      return Promise.reject(new Error("RTVI down"));
    });

    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const { startCaptionBridge, stopCaptionBridge } = await import(
      "@/lib/caption-bridge"
    );

    startCaptionBridge();

    // Drive 3 failing cycles → backoff should kick in at the 3rd failure
    for (let i = 0; i < 3; i++) {
      await advance(CYCLE);
    }

    // clearInterval + new setInterval must have been called for backoff
    expect(clearSpy).toHaveBeenCalled();
    const backoffCalls = setSpy.mock.calls.filter((c) => (c[1] as number) > CYCLE);
    expect(backoffCalls.length).toBeGreaterThan(0);
    // The backoff delay must be > 6000ms and ≤ 60000ms
    const backoffDelay = backoffCalls[0][1] as number;
    expect(backoffDelay).toBeGreaterThan(CYCLE);
    expect(backoffDelay).toBeLessThanOrEqual(60_000);

    stopCaptionBridge();
    fetchSpy.mockRestore();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it("restores 6s interval after recovery from backoff", async () => {
    vi.stubEnv("RTVI_VLM_URL", "http://127.0.0.1:9999");

    // First 3 ticks: caption fails; subsequent ticks: empty stream list (success)
    let captionCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("get-stream-info")) {
        captionCalls++;
        if (captionCalls <= 3) {
          // Return a stream so the caption endpoint is attempted
          return Promise.resolve(
            new Response(JSON.stringify([{ id: "s1" }]), { status: 200 })
          );
        }
        // Recovery: no streams → no errors
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      return Promise.reject(new Error("RTVI down"));
    });

    const setSpy = vi.spyOn(globalThis, "setInterval");

    const { startCaptionBridge, stopCaptionBridge } = await import(
      "@/lib/caption-bridge"
    );

    startCaptionBridge();

    // Drive 3 failing cycles to enter backoff
    for (let i = 0; i < 3; i++) {
      await advance(CYCLE);
    }
    const backoffCallCount = setSpy.mock.calls.filter(
      (c) => (c[1] as number) > CYCLE
    ).length;
    expect(backoffCallCount).toBeGreaterThan(0);

    // Now advance far enough for the backoff interval to fire (≤ 60s)
    await advance(60_000);

    // A setInterval at 6000ms must have been registered after the backoff ones
    const allCalls = setSpy.mock.calls;
    const recoveryIdx = allCalls.findLastIndex((c) => c[1] === CYCLE);
    // The recovery call must be after the first (initial) call at index 0
    expect(recoveryIdx).toBeGreaterThan(0);

    stopCaptionBridge();
    fetchSpy.mockRestore();
    setSpy.mockRestore();
  });
});
