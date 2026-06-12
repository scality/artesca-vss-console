import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the vst helpers the adapter wraps.
vi.mock("@/lib/helpers/vst", () => ({
  vstListSensors: vi.fn(),
  vstAddSensor: vi.fn(),
}));

import { vstListSensors, vstAddSensor } from "@/lib/helpers/vst";
import { VstClusterAdapter, ClusterAdapter } from "@/lib/reconcile/cluster-adapter";

describe("VstClusterAdapter", () => {
  beforeEach(() => {
    vi.mocked(vstListSensors).mockReset();
    vi.mocked(vstAddSensor).mockReset();
  });

  it("listSensors maps VstSensor fields to the adapter shape", async () => {
    vi.mocked(vstListSensors).mockResolvedValue({
      sensors: [
        { sensor_id: "uuid-1", name: "aisle-1", rtsp_url: "rtsp://x/aisle-1" },
        { sensor_id: "uuid-2", name: "dock-1" },
      ],
    });
    const a = new VstClusterAdapter();
    const out = await a.listSensors();
    expect(out).toEqual([
      { sensorId: "uuid-1", name: "aisle-1", rtspUrl: "rtsp://x/aisle-1" },
      { sensorId: "uuid-2", name: "dock-1", rtspUrl: undefined },
    ]);
  });

  it("listSensors returns [] when VST warns (unreachable)", async () => {
    vi.mocked(vstListSensors).mockResolvedValue({ sensors: [], warning: "unreachable" });
    const a = new VstClusterAdapter();
    expect(await a.listSensors()).toEqual([]);
  });

  it("addSensor forwards name/url/description to vstAddSensor", async () => {
    vi.mocked(vstAddSensor).mockResolvedValue({ ok: true });
    const a = new VstClusterAdapter();
    const r = await a.addSensor("aisle-1", "rtsp://x/aisle-1", "Aisle 1");
    expect(r.ok).toBe(true);
    expect(vstAddSensor).toHaveBeenCalledWith({
      sensorId: "aisle-1",
      rtspUrl: "rtsp://x/aisle-1",
      description: "Aisle 1",
    });
  });

  it("does not implement removeSensor (prune unsupported in Plan 1)", () => {
    const a: ClusterAdapter = new VstClusterAdapter();
    expect(a.removeSensor).toBeUndefined();
  });

  it("VstClusterAdapter implements the Plan-4 k8s ops", () => {
    const a = new VstClusterAdapter() as ClusterAdapter;
    for (const m of ["getDeploymentEnv", "patchDeploymentEnv", "getConfigMapKey", "patchConfigMapKey", "restartDeployment"] as const) {
      expect(typeof a[m]).toBe("function");
    }
  });
});
