// console/tests/unit/instrumentation-agent.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const startReconcileLoop = vi.fn(async () => {});
vi.mock("@/lib/reconcile-agent", () => ({ startReconcileLoop }));

describe("instrumentation register() — agent mode", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    // register() guards on globalThis.__started (survives HMR); reset it so each
    // test gets a fresh register() execution.
    delete (globalThis as unknown as { __started?: boolean }).__started;
    startReconcileLoop.mockClear();
    process.env.NEXT_RUNTIME = "nodejs";
  });
  afterEach(() => { process.env = { ...OLD }; });

  it("RECONCILE_AGENT=1 starts the loop and skips the camera watcher", async () => {
    process.env.RECONCILE_AGENT = "1";
    process.env.VSS_INSTANCE_NAME = "inst-1";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startReconcileLoop).toHaveBeenCalledTimes(1);
  });

  it("without RECONCILE_AGENT, k8s mode runs the reconcile loop (not the camera watcher)", async () => {
    delete process.env.RECONCILE_AGENT;
    process.env.VSS_INSTANCE_NAME = "inst-1";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startReconcileLoop).toHaveBeenCalledTimes(1);
  });
});
