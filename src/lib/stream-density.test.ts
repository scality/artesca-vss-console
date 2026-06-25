import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/helpers/prometheus", () => ({ promQuery: vi.fn() }));

import { promQuery } from "@/lib/helpers/prometheus";
import { collectStreamDensity } from "./stream-density";

const mockPromQuery = vi.mocked(promQuery);
const vec = (v: number) => ({ results: [{ metric: {}, value: [0, String(v)] as [number, string] }] });
const empty = { results: [] as Array<{ metric: Record<string, string>; value: [number, string] }> };

// query order: reqRate, over1s, p95, tokens, gpuUtil, gpuUsed, gpuTotal
describe("collectStreamDensity", () => {
  beforeEach(() => mockPromQuery.mockReset());

  it("computes implied streams from reqPerSec × chunk duration", async () => {
    mockPromQuery
      .mockResolvedValueOnce(vec(0.5))    // reqPerSec
      .mockResolvedValueOnce(vec(0.1))    // pctOver1s
      .mockResolvedValueOnce(vec(0.8))    // p95 secs
      .mockResolvedValueOnce(vec(420))    // tokens/sec
      .mockResolvedValueOnce(vec(88))     // gpu util
      .mockResolvedValueOnce(vec(80000))  // mem used MiB
      .mockResolvedValueOnce(vec(98304)); // mem total MiB
    const snap = await collectStreamDensity(30);
    expect(snap.estimatedActiveStreams).toBe(15);
    expect(snap.latencyP95Ms).toBe(800);
    expect(snap.verdict).toBe("ok");
    expect(snap.gpu).toEqual({ utilPct: 88, memUsedMiB: 80000, memTotalMiB: 98304 });
  });

  it("flags saturated when >= 40% of requests exceed 1s", async () => {
    mockPromQuery
      .mockResolvedValueOnce(vec(2))
      .mockResolvedValueOnce(vec(0.55))
      .mockResolvedValueOnce(vec(2.3))
      .mockResolvedValueOnce(vec(150))
      .mockResolvedValueOnce(vec(99))
      .mockResolvedValueOnce(vec(95000))
      .mockResolvedValueOnce(vec(98304));
    const snap = await collectStreamDensity(30);
    expect(snap.verdict).toBe("saturated");
  });

  it("degrades to nulls + unknown verdict when Prometheus is unreachable", async () => {
    mockPromQuery.mockResolvedValue({ ...empty, warning: "Prometheus unreachable" });
    const snap = await collectStreamDensity(30);
    expect(snap.reqPerSec).toBeNull();
    expect(snap.estimatedActiveStreams).toBeNull();
    expect(snap.verdict).toBe("unknown");
    expect(snap.warnings.length).toBeGreaterThan(0);
  });
});
