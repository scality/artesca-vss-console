// console/tests/unit/instrumentation-agent.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const startReconcileLoop = vi.fn(async () => {});
const startCameraRestoreWatcher = vi.fn();
vi.mock("@/lib/reconcile-agent", () => ({ startReconcileLoop }));
vi.mock("@/lib/camera-restore-watcher", () => ({ startCameraRestoreWatcher }));
vi.mock("@/lib/caption-bridge", () => ({ startCaptionBridge: vi.fn() }));

describe("instrumentation register() — agent mode", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    // register() guards on globalThis.__started (survives HMR); reset it so each
    // test gets a fresh register() execution.
    delete (globalThis as unknown as { __started?: boolean }).__started;
    startReconcileLoop.mockClear();
    startCameraRestoreWatcher.mockClear();
    process.env.NEXT_RUNTIME = "nodejs";
  });
  afterEach(() => { process.env = { ...OLD }; });

  it("RECONCILE_AGENT=1 starts the loop and skips the camera watcher", async () => {
    process.env.RECONCILE_AGENT = "1";
    process.env.VSS_INSTANCE_NAME = "inst-1";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startReconcileLoop).toHaveBeenCalledTimes(1);
    expect(startCameraRestoreWatcher).not.toHaveBeenCalled();
  });

  it("without RECONCILE_AGENT, the camera watcher runs and the loop does not", async () => {
    delete process.env.RECONCILE_AGENT;
    process.env.VSS_INSTANCE_NAME = "inst-1";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startReconcileLoop).not.toHaveBeenCalled();
    expect(startCameraRestoreWatcher).toHaveBeenCalledTimes(1);
  });
});
