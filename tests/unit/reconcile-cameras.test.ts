import { describe, it, expect } from "vitest";
import { reconcileCameras } from "@/lib/reconcile/cameras";
import type { ClusterAdapter, AdapterSensor } from "@/lib/reconcile/cluster-adapter";
import type { CameraEntry } from "@/lib/helpers/gcs-config";

function fakeAdapter(initial: AdapterSensor[], opts: { withRemove?: boolean } = {}): {
  adapter: ClusterAdapter;
  added: { name: string; url: string; description?: string }[];
  removed: string[];
} {
  const sensors = [...initial];
  const added: { name: string; url: string; description?: string }[] = [];
  const removed: string[] = [];
  const adapter: ClusterAdapter = {
    listSensors: async () => sensors,
    addSensor: async (name, rtspUrl, description) => {
      added.push({ name, url: rtspUrl, description });
      sensors.push({ sensorId: `uuid-${name}`, name, rtspUrl });
      return { ok: true };
    },
  };
  if (opts.withRemove) {
    adapter.removeSensor = async (sensorId) => {
      removed.push(sensorId);
      const i = sensors.findIndex((s) => s.sensorId === sensorId);
      if (i >= 0) sensors.splice(i, 1);
      return { ok: true };
    };
  }
  return { adapter, added, removed };
}

const cam = (id: string): CameraEntry => ({ id, rtspUrl: `rtsp://x:8554/${id}` });

describe("reconcileCameras", () => {
  it("adds desired cameras missing from the cluster", async () => {
    const { adapter, added } = fakeAdapter([]);
    const r = await reconcileCameras([cam("aisle-1"), cam("dock-1")], adapter, { prune: false });
    expect(added.map((a) => a.name).sort()).toEqual(["aisle-1", "dock-1"]);
    expect(r.added.sort()).toEqual(["aisle-1", "dock-1"]);
    expect(r.alreadyPresent).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.pruned).toEqual([]);
  });

  it("forwards the camera description to addSensor", async () => {
    const { adapter, added } = fakeAdapter([]);
    const withDesc: CameraEntry = { id: "aisle-1", rtspUrl: "rtsp://x:8554/aisle-1", description: "Aisle 1" };
    await reconcileCameras([withDesc], adapter, { prune: false });
    expect(added).toEqual([{ name: "aisle-1", url: "rtsp://x:8554/aisle-1", description: "Aisle 1" }]);
  });

  it("treats a sensor whose name matches a desired id as already present", async () => {
    const { adapter, added } = fakeAdapter([{ sensorId: "uuid-1", name: "aisle-1" }]);
    const r = await reconcileCameras([cam("aisle-1")], adapter, { prune: false });
    expect(added).toEqual([]);
    expect(r.alreadyPresent).toEqual(["aisle-1"]);
    expect(r.added).toEqual([]);
  });

  it("records a failed add without throwing", async () => {
    const adapter: ClusterAdapter = {
      listSensors: async () => [],
      addSensor: async () => ({ ok: false, warning: "DESCRIBE failed" }),
    };
    const r = await reconcileCameras([cam("aisle-1")], adapter, { prune: false });
    expect(r.added).toEqual([]);
    expect(r.failed).toEqual([{ id: "aisle-1", warning: "DESCRIBE failed" }]);
  });

  it("additive default leaves extra live sensors untouched and notes drift", async () => {
    const { adapter, removed } = fakeAdapter(
      [{ sensorId: "uuid-x", name: "stale-cam" }],
      { withRemove: true },
    );
    const r = await reconcileCameras([cam("aisle-1")], adapter, { prune: false });
    expect(removed).toEqual([]); // never prune when prune:false
    expect(r.pruned).toEqual([]);
    expect(r.drift).toContain("extra live sensor not in desired: stale-cam");
  });

  it("prune removes live sensors not in the desired set", async () => {
    const { adapter, removed } = fakeAdapter(
      [{ sensorId: "uuid-x", name: "stale-cam" }, { sensorId: "uuid-1", name: "aisle-1" }],
      { withRemove: true },
    );
    const r = await reconcileCameras([cam("aisle-1")], adapter, { prune: true });
    expect(removed).toEqual(["uuid-x"]);
    expect(r.pruned).toEqual(["stale-cam"]);
    expect(r.alreadyPresent).toEqual(["aisle-1"]);
  });

  it("prune is a no-op when the adapter cannot remove", async () => {
    const { adapter } = fakeAdapter([{ sensorId: "uuid-x", name: "stale-cam" }]); // no removeSensor
    const r = await reconcileCameras([cam("aisle-1")], adapter, { prune: true });
    expect(r.pruned).toEqual([]);
    expect(r.drift).toContain("extra live sensor not in desired: stale-cam");
  });
});
