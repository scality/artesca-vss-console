import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/helpers/prometheus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/helpers/prometheus")>()),
  promQuery: vi.fn(),
}));

import { promQuery } from "@/lib/helpers/prometheus";
import { collectStreamDensity } from "./stream-density";

const mockPromQuery = vi.mocked(promQuery);
type Sample = { metric: Record<string, string>; value: [number, string] };
const vec = (v: number) => ({ results: [{ metric: {}, value: [0, String(v)] as [number, string] }] });
const empty = { results: [] as Sample[] };

/** DCGM-shaped result set: one sample per GPU index. */
const perGpu = (byIndex: Record<string, number>, modelName?: string) => ({
  results: Object.entries(byIndex).map(([gpu, v]) => ({
    metric: { gpu, ...(modelName ? { modelName } : {}) },
    value: [0, String(v)] as [number, string],
  })),
});

// query order: reqRate, over1s, p95, tokens, streams, gpuUtil, gpuUsed, gpuTotal, gpuFree
describe("collectStreamDensity", () => {
  beforeEach(() => mockPromQuery.mockReset());

  it("computes implied streams from reqPerSec × chunk duration", async () => {
    mockPromQuery
      .mockResolvedValueOnce(vec(0.5))    // reqPerSec
      .mockResolvedValueOnce(vec(0.1))    // pctOver1s
      .mockResolvedValueOnce(vec(0.8))    // p95 secs
      .mockResolvedValueOnce(vec(420))    // tokens/sec
      .mockResolvedValueOnce(vec(5))      // active_live_streams
      .mockResolvedValueOnce(perGpu({ "0": 88 }))     // gpu util
      .mockResolvedValueOnce(perGpu({ "0": 80000 }))  // mem used MiB
      .mockResolvedValueOnce(perGpu({ "0": 98304 }))  // mem total MiB
      .mockResolvedValueOnce(empty);                  // mem free MiB
    const snap = await collectStreamDensity(30);
    expect(snap.estimatedActiveStreams).toBe(15);
    expect(snap.activeStreams).toBe(5);
    expect(snap.latencyP95Ms).toBe(800);
    expect(snap.verdict).toBe("ok");
    expect(snap.gpu).toEqual({
      index: 0,
      name: "GPU 0",
      utilPct: 88,
      memUsedMiB: 80000,
      memTotalMiB: 98304,
    });
  });

  it("headlines the busiest card, not the first DCGM listed", async () => {
    // The showroom shape: GPU 0 idle with an unrelated tenant, the VLM pinning
    // GPU 1. Reading results[0] reported 0% while the working card sat at 92%.
    mockPromQuery
      .mockResolvedValueOnce(vec(0.04))
      .mockResolvedValueOnce(vec(0.1))
      .mockResolvedValueOnce(vec(9.25))
      .mockResolvedValueOnce(vec(13.6))
      .mockResolvedValueOnce(vec(5))
      .mockResolvedValueOnce(perGpu({ "0": 0, "1": 92 }, "NVIDIA RTX PRO 6000 Blackwell Server Edition"))
      .mockResolvedValueOnce(perGpu({ "0": 7044, "1": 71568 }))
      .mockResolvedValueOnce(perGpu({ "0": 97887, "1": 97887 }))
      .mockResolvedValueOnce(empty);
    const snap = await collectStreamDensity(30);
    expect(snap.gpus.map((g) => g.index)).toEqual([0, 1]);
    expect(snap.gpu?.index).toBe(1);
    expect(snap.gpu?.utilPct).toBe(92);
    expect(snap.gpu?.name).toBe("NVIDIA RTX PRO 6000 Blackwell Server Edition");
    expect(snap.gpus[0]).toMatchObject({ index: 0, utilPct: 0, memUsedMiB: 7044 });
  });

  it("derives VRAM total from used + free when DCGM omits FB_TOTAL", async () => {
    mockPromQuery
      .mockResolvedValueOnce(vec(0.5))
      .mockResolvedValueOnce(vec(0.1))
      .mockResolvedValueOnce(vec(0.8))
      .mockResolvedValueOnce(vec(420))
      .mockResolvedValueOnce(vec(2))
      .mockResolvedValueOnce(perGpu({ "1": 92 }))
      .mockResolvedValueOnce(perGpu({ "1": 71568 }))
      .mockResolvedValueOnce(empty)                     // no FB_TOTAL
      .mockResolvedValueOnce(perGpu({ "1": 25681 }));   // FB_FREE
    const snap = await collectStreamDensity(30);
    expect(snap.gpu?.memTotalMiB).toBe(71568 + 25681);
  });

  it("reports memTotalMiB 0 rather than a bogus total when DCGM has neither", async () => {
    mockPromQuery
      .mockResolvedValueOnce(vec(0.5))
      .mockResolvedValueOnce(vec(0.1))
      .mockResolvedValueOnce(vec(0.8))
      .mockResolvedValueOnce(vec(420))
      .mockResolvedValueOnce(vec(2))
      .mockResolvedValueOnce(perGpu({ "0": 12 }))
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty);
    const snap = await collectStreamDensity(30);
    expect(snap.gpu?.memTotalMiB).toBe(0);
  });

  it("flags saturated when >= 40% of requests exceed 1s", async () => {
    mockPromQuery
      .mockResolvedValueOnce(vec(2))
      .mockResolvedValueOnce(vec(0.55))
      .mockResolvedValueOnce(vec(2.3))
      .mockResolvedValueOnce(vec(150))
      .mockResolvedValueOnce(vec(12))
      .mockResolvedValueOnce(perGpu({ "0": 99 }))
      .mockResolvedValueOnce(perGpu({ "0": 95000 }))
      .mockResolvedValueOnce(perGpu({ "0": 98304 }))
      .mockResolvedValueOnce(empty);
    const snap = await collectStreamDensity(30);
    expect(snap.verdict).toBe("saturated");
  });

  it("degrades to nulls + unknown verdict when Prometheus is unreachable", async () => {
    mockPromQuery.mockResolvedValue({ ...empty, warning: "Prometheus unreachable" });
    const snap = await collectStreamDensity(30);
    expect(snap.reqPerSec).toBeNull();
    expect(snap.activeStreams).toBeNull();
    expect(snap.estimatedActiveStreams).toBeNull();
    expect(snap.gpus).toEqual([]);
    expect(snap.gpu).toBeNull();
    expect(snap.verdict).toBe("unknown");
    expect(snap.warnings.length).toBeGreaterThan(0);
  });

  it("reads the VLM series, not nim_*", async () => {
    mockPromQuery.mockResolvedValue(empty);
    await collectStreamDensity(30);
    const queries = mockPromQuery.mock.calls.map(([q]) => q);
    expect(queries.some((q) => q.includes("nim_"))).toBe(false);
    expect(queries).toContain("sum(rate(vlm_latency_seconds_count[5m]))");
    expect(queries).toContain("sum(active_live_streams)");
    expect(queries.some((q) => q.includes('vlm_latency_seconds_bucket{le="1.0"}'))).toBe(true);
  });
});
