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
});

describe("instrumentation full-console mode", () => {
  it("k8s mode → runs reconcile loop, not the GCS restore watcher", async () => {
    const { register } = await import("@/instrumentation");
    await register();
    expect(startReconcileLoop).toHaveBeenCalled();
    expect(startCameraRestoreWatcher).not.toHaveBeenCalled();
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
