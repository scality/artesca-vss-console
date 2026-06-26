import { describe, it, expect, vi, beforeEach } from "vitest";

const startReconcileLoop = vi.fn().mockResolvedValue(undefined);
const startCameraRestoreWatcher = vi.fn();
const startCaptionBridge = vi.fn();

vi.mock("@/lib/reconcile-agent", () => ({ startReconcileLoop }));
vi.mock("@/lib/camera-restore-watcher", () => ({ startCameraRestoreWatcher }));
vi.mock("@/lib/caption-bridge", () => ({ startCaptionBridge }));
vi.mock("@/lib/deprecation-filter", () => ({ filterUrlParseDeprecation: vi.fn() }));
vi.mock("@/lib/logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  (globalThis as Record<string, unknown>).__started = false;
  process.env.NEXT_RUNTIME = "nodejs";
  process.env.AUTH_SECRET = "x";
  process.env.VSS_INSTANCE_NAME = "inst-1";
  delete process.env.RECONCILE_AGENT;
  delete process.env.CONSOLE_RUNTIME;
  delete process.env.CONSOLE_DISABLE_RECONCILE_LOOP;
});

describe("instrumentation full-console mode", () => {
  it("k8s mode (flag unset) → starts reconcile loop with periodic:true", async () => {
    const { register } = await import("@/instrumentation");
    await register();
    expect(startReconcileLoop).toHaveBeenCalledWith({ periodic: true });
    expect(startCameraRestoreWatcher).not.toHaveBeenCalled();
  });

  it("k8s mode (CONSOLE_DISABLE_RECONCILE_LOOP=1) → STILL starts loop, with periodic:false", async () => {
    process.env.CONSOLE_DISABLE_RECONCILE_LOOP = "1";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startReconcileLoop).toHaveBeenCalledWith({ periodic: false });
  });

  it("docker mode → runs GCS restore watcher + caption bridge, not the loop", async () => {
    process.env.CONSOLE_RUNTIME = "docker";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startCameraRestoreWatcher).toHaveBeenCalledWith("inst-1");
    expect(startCaptionBridge).toHaveBeenCalled();
    expect(startReconcileLoop).not.toHaveBeenCalled();
  });
});
