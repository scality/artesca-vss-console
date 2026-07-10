import { describe, it, expect } from "vitest";
import { formatAgeMs, glob2regex, cn } from "@/lib/utils";

describe("formatAgeMs", () => {
  it("shows seconds for sub-minute durations", () => {
    expect(formatAgeMs(45_000)).toBe("45s");
  });

  it("shows minutes and seconds for 1-60 minute durations", () => {
    expect(formatAgeMs(90_000)).toBe("1m30s");
    expect(formatAgeMs(5 * 60 * 1000)).toBe("5m0s");
  });

  it("shows hours and minutes for multi-hour durations", () => {
    expect(formatAgeMs(2 * 3600 * 1000 + 23 * 60 * 1000)).toBe("2h23m");
  });

  it("shows days and hours for multi-day durations", () => {
    expect(formatAgeMs(3 * 86400 * 1000 + 5 * 3600 * 1000)).toBe("3d5h");
  });

  it("handles zero", () => {
    expect(formatAgeMs(0)).toBe("0s");
  });
});

describe("glob2regex", () => {
  it("matches exact string", () => {
    expect(glob2regex("checkout-1-a").test("checkout-1-a")).toBe(true);
    expect(glob2regex("checkout-1-a").test("checkout-1-b")).toBe(false);
  });

  it("handles * wildcard (no slash crossing)", () => {
    const re = glob2regex("checkout-*");
    expect(re.test("checkout-1-a")).toBe(true);
    expect(re.test("checkout-2-b")).toBe(true);
    expect(re.test("aisle-1")).toBe(false);
  });

  it("handles ** wildcard (crosses slashes)", () => {
    const re = glob2regex("**");
    expect(re.test("checkout-1-a")).toBe(true);
    expect(re.test("anything/here")).toBe(true);
  });

  it("escapes regex metacharacters", () => {
    const re = glob2regex("sensor.+1");
    expect(re.test("sensor.+1")).toBe(true);
    expect(re.test("sensorXX1")).toBe(false);
  });

  it("does not match partial strings", () => {
    expect(glob2regex("foo").test("foobar")).toBe(false);
  });

  it("handles checkout-* pattern against multiple feeds", () => {
    const re = glob2regex("checkout-*");
    expect(re.test("checkout-1-a")).toBe(true);
    expect(re.test("checkout-1-b")).toBe(true);
    expect(re.test("checkout-99-z")).toBe(true);
  });
});

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("handles falsy values", () => {
    expect(cn("foo", false && "bar", undefined, "baz")).toBe("foo baz");
  });

  it("deduplicates Tailwind classes by keeping the last one", () => {
    // tailwind-merge keeps the last conflicting class
    const result = cn("p-2", "p-4");
    expect(result).toBe("p-4");
  });
});
