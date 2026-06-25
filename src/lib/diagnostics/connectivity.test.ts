import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/reconcile/context", () => ({
  makeReconcileContext: vi.fn(),
}));

import { makeReconcileContext } from "@/lib/reconcile/context";
import { probeConfigStore } from "./connectivity";

const mockMakeCtx = vi.mocked(makeReconcileContext);

function ctxWith(readStatus: () => Promise<unknown>) {
  return { store: { readStatus }, instance: "pyramid-showroom" } as never;
}

describe("probeConfigStore", () => {
  beforeEach(() => {
    mockMakeCtx.mockReset();
    process.env.VSS_INSTANCE_NAME = "pyramid-showroom";
    delete process.env.CONSOLE_DISABLE_RECONCILE_LOOP;
  });

  it("error when VSS_INSTANCE_NAME is unset", async () => {
    delete process.env.VSS_INSTANCE_NAME;
    const s = await probeConfigStore();
    expect(s.severity).toBe("error");
    expect(s.ok).toBe(false);
    expect(s.detail).toMatch(/VSS_INSTANCE_NAME/);
  });

  it("error when the Firestore client fails to load (module missing)", async () => {
    mockMakeCtx.mockRejectedValue(new Error("Firestore init failed: Cannot find module '@google-cloud/firestore'"));
    const s = await probeConfigStore();
    expect(s.severity).toBe("error");
    expect(s.detail).toMatch(/Cannot find module '@google-cloud\/firestore'/);
    expect(s.ok).toBe(false);
  });

  it("error when the test read throws (permission/unreachable)", async () => {
    mockMakeCtx.mockResolvedValue(ctxWith(() => Promise.reject(new Error("PERMISSION_DENIED"))));
    const s = await probeConfigStore();
    expect(s.severity).toBe("error");
    expect(s.detail).toMatch(/PERMISSION_DENIED/);
  });

  it("ok when instance set, client loads, and read succeeds", async () => {
    mockMakeCtx.mockResolvedValue(ctxWith(() => Promise.resolve({})));
    const s = await probeConfigStore();
    expect(s.severity).toBe("ok");
    expect(s.ok).toBe(true);
    expect(s.detail).toMatch(/reachable/);
  });

  it("warn (not error) when healthy but reconcile loop is disabled", async () => {
    process.env.CONSOLE_DISABLE_RECONCILE_LOOP = "1";
    mockMakeCtx.mockResolvedValue(ctxWith(() => Promise.resolve({})));
    const s = await probeConfigStore();
    expect(s.severity).toBe("warn");
    expect(s.ok).toBe(true); // warn is not an outage
    expect(s.detail).toMatch(/reconcile loop off/i);
  });
});
