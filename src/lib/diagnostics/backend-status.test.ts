import { describe, it, expect } from "vitest";
import { statusWord } from "@/lib/diagnostics/backend-status";

describe("statusWord()", () => {
  it("ok / warn / unreachable / unset", () => {
    const b = (spec: { ok?: boolean; detail?: string }) => ({
      ok: false,
      detail: "test",
      ...spec,
    });
    expect(statusWord(b({ ok: true }))).toBe("ok");
    expect(statusWord(b({ detail: "not configured" }))).toBe("not configured");
    expect(statusWord(b({ ok: false, detail: "connection timed out" }))).toBe("timeout");
    expect(statusWord(b({ detail: "unreachable" }))).toBe("unreachable");
  });
});
