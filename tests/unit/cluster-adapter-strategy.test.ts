import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/helpers/vst", () => ({ vstListSensors: vi.fn(), vstAddSensor: vi.fn() }));
vi.mock("@/lib/helpers/configmaps", () => ({ readConfigMapKey: vi.fn(), patchConfigMapRawKey: vi.fn() }));
const read = vi.fn();
const patch = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/k8s", () => ({
  appsV1: () => ({ readNamespacedDeployment: read, patchNamespacedDeployment: patch }),
  rolloutRestart: vi.fn(),
}));
import { VstClusterAdapter } from "@/lib/reconcile/cluster-adapter";

describe("ensureDeploymentStrategy", () => {
  it("patches strategy when it is not the desired type", async () => {
    read.mockResolvedValue({ spec: { strategy: { type: "RollingUpdate" } } });
    const a = new VstClusterAdapter();
    expect(await a.ensureDeploymentStrategy("vss-alerts", "vss-rtvi-vlm", "Recreate")).toBe(true);
    expect(patch).toHaveBeenCalled();
  });
  it("no-ops when already set", async () => {
    read.mockResolvedValue({ spec: { strategy: { type: "Recreate" } } });
    patch.mockClear();
    const a = new VstClusterAdapter();
    expect(await a.ensureDeploymentStrategy("vss-alerts", "vss-rtvi-vlm", "Recreate")).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
});
