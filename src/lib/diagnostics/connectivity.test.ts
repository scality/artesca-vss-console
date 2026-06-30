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

  it("ok + 'converged' detail when readStatus returns a clean status", async () => {
    mockMakeCtx.mockResolvedValue(ctxWith(() => Promise.resolve({ lastRunAt: "2026-06-26T10:00:00Z", errors: [] })));
    const s = await probeConfigStore();
    expect(s.severity).toBe("ok");
    expect(s.ok).toBe(true);
    expect(s.detail).toMatch(/converged/i);
    expect(s.detail).toMatch(/2026-06-26T10:00:00Z/);
  });

  it("stays ok (reachable) even when the last convergence reported errors", async () => {
    mockMakeCtx.mockResolvedValue(ctxWith(() => Promise.resolve({ lastRunAt: "2026-06-26T10:00:00Z", errors: ["addSensor failed: cam-1"] })));
    const s = await probeConfigStore();
    expect(s.severity).toBe("ok"); // reachability only — reconcile errors don't degrade the store signal
    expect(s.ok).toBe(true);
    expect(s.detail).toMatch(/reachable/i);
    expect(s.detail).toMatch(/1 error/i);
  });

  it("ok + 'reachable' when no status has been written yet (null)", async () => {
    mockMakeCtx.mockResolvedValue(ctxWith(() => Promise.resolve(null)));
    const s = await probeConfigStore();
    expect(s.severity).toBe("ok");
    expect(s.detail).toMatch(/reachable/i);
  });
});
