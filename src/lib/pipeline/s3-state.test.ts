import { describe, it, expect } from "vitest";
import { computeS3State } from "./s3-state";

const GiB = 1024 ** 3;
const base = { bucket: "rec", endpoint: null, capacityBytes: 0, prev: undefined, nowMs: 1_000_000 };

describe("computeS3State", () => {
  it("fills against the configured capacity, not a fixed ceiling", () => {
    const { state } = computeS3State({
      ...base,
      capacityBytes: 20 * 1024 * GiB,
      totals: { objectCount: 394_815, bytesTotal: 6.99 * 1024 * GiB },
    });
    expect(state.capacityBytes).toBe(20 * 1024 * GiB);
    expect(state.capacityPct).toBeCloseTo((6.99 / 20) * 100, 3);
  });

  it("reports an unknown capacity as null rather than as a percentage", () => {
    const { state } = computeS3State({ ...base, totals: { objectCount: 1, bytesTotal: 500 * GiB } });
    expect(state.capacityBytes).toBeNull();
    expect(state.capacityPct).toBeNull();
  });

  it("measures the PUT rate between two different totals", () => {
    const first = computeS3State({ ...base, totals: { objectCount: 100, bytesTotal: 100 * 1024 * 1024 } });
    expect(first.state.putRateMBps).toBe(0);
    const second = computeS3State({
      ...base,
      nowMs: base.nowMs + 10_000,
      prev: first.sample,
      totals: { objectCount: 160, bytesTotal: 200 * 1024 * 1024 },
    });
    expect(second.state.putRateMBps).toBeCloseTo(10, 6); // 100 MiB over 10 s
    expect(second.state.putRateObjPerMin).toBeCloseTo(360, 6); // 60 objects over 10 s
  });

  it("holds the previous rate while the cached total has not moved", () => {
    const first = computeS3State({ ...base, totals: { objectCount: 100, bytesTotal: 100 * 1024 * 1024 } });
    const second = computeS3State({
      ...base,
      nowMs: base.nowMs + 10_000,
      prev: first.sample,
      totals: { objectCount: 160, bytesTotal: 200 * 1024 * 1024 },
    });
    const third = computeS3State({
      ...base,
      nowMs: base.nowMs + 15_000,
      prev: second.sample,
      totals: { objectCount: 160, bytesTotal: 200 * 1024 * 1024 },
    });
    expect(third.state.putRateMBps).toBe(second.state.putRateMBps);
    expect(third.sample).toBe(second.sample); // the reference sample is unchanged too
  });

  it("carries the scan's truncation flag", () => {
    const { state } = computeS3State({ ...base, totals: { objectCount: 1, bytesTotal: 1, truncated: true } });
    expect(state.bucketScanTruncated).toBe(true);
  });
});
