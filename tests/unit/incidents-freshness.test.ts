/**
 * incidents-freshness.test.ts
 *
 * Verifies the formatAge helper exported from incidents/page.tsx, which drives
 * the "last Xs ago" freshness indicator near the Live badge.
 */

import { describe, it, expect } from "vitest";
import { formatAge } from "@/lib/format-age";

describe("formatAge", () => {
  it("shows seconds under 60", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(1)).toBe("1s");
    expect(formatAge(59)).toBe("59s");
  });

  it("shows minutes and seconds from 60 s up", () => {
    expect(formatAge(60)).toBe("1m");
    expect(formatAge(61)).toBe("1m 1s");
    expect(formatAge(75)).toBe("1m 15s");
    expect(formatAge(119)).toBe("1m 59s");
    expect(formatAge(120)).toBe("2m");
  });

  it("omits seconds component when it is zero", () => {
    expect(formatAge(60)).toBe("1m");
    expect(formatAge(120)).toBe("2m");
    expect(formatAge(3600)).toBe("1h");
  });

  it("shows hours and minutes from 60 min up", () => {
    expect(formatAge(3600)).toBe("1h");
    expect(formatAge(3660)).toBe("1h 1m");
    expect(formatAge(3725)).toBe("1h 2m");
    expect(formatAge(7200)).toBe("2h");
  });

  it("omits minutes component when it is zero in hour display", () => {
    expect(formatAge(3600)).toBe("1h");
    expect(formatAge(7200)).toBe("2h");
  });

  // Boundary: the amber threshold used by the page is ageS >= 60.
  it("60s is the first age that would render amber", () => {
    expect(formatAge(59)).toBe("59s"); // still neutral
    expect(formatAge(60)).toBe("1m");  // amber threshold crossed
  });
});
