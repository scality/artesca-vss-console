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
    adapter.removeSensor = async (key) => {
      removed.push(key);
      const i = sensors.findIndex((s) => s.uuid === key || s.sensorId === key);
      if (i >= 0) sensors.splice(i, 1);
      return { ok: true };
    };
  }
  return { adapter, added, removed };
}

const cam = (id: string): CameraEntry => ({ id, rtspUrl: `rtsp://x:8554/${id}` });
const disabledCam = (id: string): CameraEntry => ({
  id,
  rtspUrl: `rtsp://x:8554/${id}`,
  recording: { enabled: false, policy: "always", retentionDays: 7 },
});
const enabledCam = (id: string): CameraEntry => ({
  id,
  rtspUrl: `rtsp://x:8554/${id}`,
  recording: { enabled: true, policy: "always", retentionDays: 7 },
});

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

  // ── VST tombstones (state:"removed") are not sensors ──
  //
  // VST keeps a deleted sensor in /sensor/list as status:"removed" rather than
  // dropping it, so every camera ever deleted came back as an "extra live sensor"
  // on every pass. Measured on pyramid-showroom 2026-08-14: 21 list entries, 5
  // online cameras matching the store, 15 tombstones and 1 offline stub — the same
  // 16 drift notes every 60s for over a week. The adapter was discarding the field
  // that tells them apart, so the reconciler could not have known.

  it("ignores removed tombstones when reporting extra sensors", async () => {
    const { adapter } = fakeAdapter([
      { sensorId: "uuid-gone", name: "deleted-cam", status: "removed" },
      { sensorId: "uuid-1", name: "aisle-1", status: "online" },
    ]);
    const r = await reconcileCameras([cam("aisle-1")], adapter, { prune: false });
    // The whole point: the drift list is EMPTY, so a real difference would stand out.
    expect(r.drift).toEqual([]);
    expect(r.alreadyPresent).toEqual(["aisle-1"]);
  });

  it("still reports a genuine extra sensor that is online", async () => {
    // The guard must not silence the case the drift note exists for.
    const { adapter } = fakeAdapter([
      { sensorId: "uuid-gone", name: "deleted-cam", status: "removed" },
      { sensorId: "uuid-x", name: "stale-cam", status: "online" },
    ]);
    const r = await reconcileCameras([cam("aisle-1")], adapter, { prune: false });
    expect(r.drift).toEqual(["extra live sensor not in desired: stale-cam"]);
  });

  it("reports an extra sensor whose status is absent", async () => {
    // Only "removed" is a tombstone. An unknown or missing status is a sensor we
    // cannot rule out, and staying silent about it would trade one blind spot for
    // another — every existing test above supplies no status at all.
    const { adapter } = fakeAdapter([{ sensorId: "uuid-x", name: "stale-cam" }]);
    const r = await reconcileCameras([cam("aisle-1")], adapter, { prune: false });
    expect(r.drift).toContain("extra live sensor not in desired: stale-cam");
  });

  it("never prunes a tombstone", async () => {
    // With prune on, each tombstone would otherwise be a removeSensor call per
    // pass, forever, against a sensor VST has already deleted.
    const { adapter, removed } = fakeAdapter(
      [
        { sensorId: "uuid-gone", name: "deleted-cam", status: "removed" },
        { sensorId: "uuid-x", name: "stale-cam", status: "online" },
      ],
      { withRemove: true },
    );
    const r = await reconcileCameras([cam("aisle-1")], adapter, { prune: true });
    expect(removed).toEqual(["uuid-x"]);
    expect(r.pruned).toEqual(["stale-cam"]);
  });

  // ── parking disabled cameras (recording.enabled === false) ──

  it("parks a disabled camera that is currently live (de-registers, independent of prune)", async () => {
    const { adapter, removed } = fakeAdapter(
      [{ sensorId: "uuid-pc0", name: "pyramid-cam0" }],
      { withRemove: true },
    );
    const r = await reconcileCameras([disabledCam("pyramid-cam0")], adapter, { prune: false });
    expect(removed).toEqual(["uuid-pc0"]);
    expect(r.parked).toEqual(["pyramid-cam0"]);
    expect(r.added).toEqual([]);
    expect(r.alreadyPresent).toEqual([]);
    expect(r.drift).toContain("parked disabled camera (de-registered live sensor): pyramid-cam0");
  });

  it("parks by the real VIOS UUID when name != uuid (the k8s-path delete key)", async () => {
    const { adapter, removed } = fakeAdapter(
      [{ sensorId: "pyramid-cam0", uuid: "f0094a7b-98b3-4934-ac3a-0b2ef406097d", name: "pyramid-cam0" }],
      { withRemove: true },
    );
    const r = await reconcileCameras([disabledCam("pyramid-cam0")], adapter, { prune: false });
    // Delete must use the UUID, not the name — deleting by name returns HTTP 4xx.
    expect(removed).toEqual(["f0094a7b-98b3-4934-ac3a-0b2ef406097d"]);
    expect(r.parked).toEqual(["pyramid-cam0"]);
  });

  it("never adds a disabled camera that is not live", async () => {
    const { adapter, added, removed } = fakeAdapter([], { withRemove: true });
    const r = await reconcileCameras([disabledCam("pyramid-cam0")], adapter, { prune: false });
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
    expect(r.parked).toEqual([]);
    expect(r.added).toEqual([]);
  });

  it("parking a live disabled camera is a graceful no-op when the adapter cannot remove", async () => {
    const { adapter } = fakeAdapter([{ sensorId: "uuid-pc0", name: "pyramid-cam0" }]); // no removeSensor
    const r = await reconcileCameras([disabledCam("pyramid-cam0")], adapter, { prune: false });
    expect(r.parked).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.added).toEqual([]);
  });

  it("adds an explicitly recording-enabled camera normally (park gate does not false-fire)", async () => {
    const { adapter, added } = fakeAdapter([]);
    const r = await reconcileCameras([enabledCam("aisle-1")], adapter, { prune: false });
    expect(added.map((a) => a.name)).toEqual(["aisle-1"]);
    expect(r.added).toEqual(["aisle-1"]);
    expect(r.parked).toEqual([]);
  });

  it("parks disabled cameras while still adding enabled ones in the same run", async () => {
    const { adapter, added, removed } = fakeAdapter(
      [{ sensorId: "uuid-pc0", name: "pyramid-cam0" }],
      { withRemove: true },
    );
    const r = await reconcileCameras(
      [disabledCam("pyramid-cam0"), enabledCam("aisle-1")],
      adapter,
      { prune: false },
    );
    expect(removed).toEqual(["uuid-pc0"]);
    expect(added.map((a) => a.name)).toEqual(["aisle-1"]);
    expect(r.parked).toEqual(["pyramid-cam0"]);
    expect(r.added).toEqual(["aisle-1"]);
  });
});
