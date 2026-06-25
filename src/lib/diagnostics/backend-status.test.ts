import { describe, it, expect } from "vitest";
import { severityOf, statusWord } from "./backend-status";

const b = (over: Partial<{ ok: boolean; severity: "ok" | "warn" | "error"; detail: string }>) =>
  ({ id: "config-store", label: "x", ok: true, detail: "", latencyMs: 0, ...over }) as const;

describe("severityOf", () => {
  it("uses explicit severity when present", () => {
    expect(severityOf(b({ severity: "warn", ok: true }))).toBe("warn");
    expect(severityOf(b({ severity: "error", ok: false }))).toBe("error");
  });
  it("derives from ok when severity absent", () => {
    expect(severityOf(b({ ok: true }))).toBe("ok");
    expect(severityOf(b({ ok: false }))).toBe("error");
  });
});

describe("statusWord", () => {
  it("ok / warn / unreachable / unset", () => {
    expect(statusWord(b({ ok: true }))).toBe("ok");
    expect(statusWord(b({ severity: "warn", ok: true }))).toBe("degraded");
    expect(statusWord(b({ ok: false, detail: "VSS_INSTANCE_NAME unset" }))).toBe("not configured");
    expect(statusWord(b({ ok: false, detail: "connection timed out" }))).toBe("timeout");
    expect(statusWord(b({ ok: false, detail: "boom" }))).toBe("unreachable");
  });
});
