import { describe, it, expect } from "vitest";
import { formatBytes } from "@/lib/format-bytes";

describe("formatBytes", () => {
  it("formats zero / negative / non-finite as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });

  it("formats bytes without decimals", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats KB/MB/GB/TB with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(702858164407)).toBe("654.6 GB");
    expect(formatBytes(12802527166464)).toBe("11.6 TB");
  });

  it("honours the digits argument", () => {
    expect(formatBytes(1536, 2)).toBe("1.50 KB");
  });
});
