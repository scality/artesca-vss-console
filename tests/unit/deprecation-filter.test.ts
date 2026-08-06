/**
 * The filter exists to drop two upstream warnings without dropping our own.
 * These tests pin the boundary, because a filter that is slightly too broad is
 * worse than no filter: it removes a signal while looking like housekeeping.
 */
import { describe, it, expect } from "vitest";
import { isEpochScaleNegativeTimeout } from "@/lib/deprecation-filter";

// The literal warning kafkajs provokes, from pyramid-showroom's pod log.
const KAFKAJS = "-1786016591181 is a negative number.\nTimeout duration was set to 1.";

describe("isEpochScaleNegativeTimeout", () => {
  it("drops the epoch-magnitude value kafkajs produces", () => {
    expect(isEpochScaleNegativeTimeout("TimeoutNegativeWarning", KAFKAJS)).toBe(true);
  });

  it("keeps a small negative — that would be our own arithmetic", () => {
    for (const ms of [-1, -5, -250, -30_000, -86_400_000]) {
      const text = `${ms} is a negative number.\nTimeout duration was set to 1.`;
      expect(isEpochScaleNegativeTimeout("TimeoutNegativeWarning", text)).toBe(false);
    }
  });

  it("keeps values just above the epoch threshold", () => {
    // 12 digits — a ~31-year delay. Absurd, but not the `X - Date.now()` shape,
    // so it stays visible.
    const text = "-999999999999 is a negative number.";
    expect(isEpochScaleNegativeTimeout("TimeoutNegativeWarning", text)).toBe(false);
  });

  it("ignores other warning types carrying a large negative", () => {
    expect(isEpochScaleNegativeTimeout("DeprecationWarning", KAFKAJS)).toBe(false);
    expect(isEpochScaleNegativeTimeout(undefined, KAFKAJS)).toBe(false);
  });

  it("accepts an Error instance, which is how Node may pass the warning", () => {
    expect(isEpochScaleNegativeTimeout("TimeoutNegativeWarning", new Error(KAFKAJS))).toBe(true);
  });

  it("does not match a warning with no number in it", () => {
    expect(isEpochScaleNegativeTimeout("TimeoutNegativeWarning", "something odd")).toBe(false);
  });
});
