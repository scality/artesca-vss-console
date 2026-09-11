import { describe, it, expect } from "vitest";
import { busiestGpuHeadline } from "./gpu-kpi";
import type { GpuState } from "@/lib/types";

const gpu = (index: number, utilGpu: number): GpuState => ({
  index,
  name: `GPU ${index}`,
  memoryUsedMiB: 0,
  memoryTotalMiB: 1,
  utilGpu,
  utilMem: 0,
  tempC: 0,
  powerW: 0,
  processes: [],
});

describe("busiestGpuHeadline", () => {
  it("returns null value/label with no GPUs reporting", () => {
    expect(busiestGpuHeadline([])).toEqual({ value: null, label: null, perCard: "" });
  });

  it("headlines the busiest card, not an average across cards", () => {
    // The showroom shape: the VLM's card at 47%, the other idle by design.
    // Averaging read 23% ((47+0)/2) — the fix names the busy card instead.
    const headline = busiestGpuHeadline([gpu(0, 47), gpu(1, 0)]);
    expect(headline.value).toBe(47);
    expect(headline.label).toBe("GPU 0");
    expect(headline.perCard).toBe("GPU 0 · 47% · GPU 1 · 0%");
  });

  it("names whichever card is busiest regardless of index order", () => {
    const headline = busiestGpuHeadline([gpu(0, 5), gpu(1, 92)]);
    expect(headline.value).toBe(92);
    expect(headline.label).toBe("GPU 1");
    expect(headline.perCard).toBe("GPU 0 · 5% · GPU 1 · 92%");
  });

  it("sorts the per-card sub-line by index regardless of input order", () => {
    const headline = busiestGpuHeadline([gpu(2, 10), gpu(0, 60), gpu(1, 20)]);
    expect(headline.perCard).toBe("GPU 0 · 60% · GPU 1 · 20% · GPU 2 · 10%");
  });

  it("breaks a tie on the lower index", () => {
    const headline = busiestGpuHeadline([gpu(0, 50), gpu(1, 50)]);
    expect(headline.label).toBe("GPU 0");
  });

  it("rounds fractional utilisation", () => {
    const headline = busiestGpuHeadline([gpu(0, 46.6)]);
    expect(headline.value).toBe(47);
    expect(headline.perCard).toBe("GPU 0 · 47%");
  });
});
