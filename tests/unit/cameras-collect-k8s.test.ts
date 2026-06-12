import { describe, it, expect } from "vitest";
import { buildK8sCamerasResponse } from "@/lib/cameras/collect-k8s";
import type { CameraEntry } from "@/lib/config-store/types";

const desired: CameraEntry[] = [
  { id: "aisle-1", rtspUrl: "rtsp://x:8554/aisle-1", role: "aisle", description: "Aisle 1", scenarioIds: ["fall"] },
  { id: "dock-1", rtspUrl: "rtsp://x:8554/dock-1" },
];

describe("buildK8sCamerasResponse", () => {
  it("marks vstRegistered from the live sensor name set", () => {
    const out = buildK8sCamerasResponse(desired, ["aisle-1"], new Map(), null);
    const aisle = out.cameras.find((c) => c.id === "aisle-1")!;
    const dock = out.cameras.find((c) => c.id === "dock-1")!;
    expect(aisle.feeds[0].vstRegistered).toBe(true);
    expect(dock.feeds[0].vstRegistered).toBe(false);
  });

  it("carries scenarioIds + role + gcsPersisted:true from the Firestore entry", () => {
    const out = buildK8sCamerasResponse(desired, [], new Map(), null);
    const aisle = out.cameras.find((c) => c.id === "aisle-1")!;
    expect(aisle.scenarioIds).toEqual(["fall"]);
    expect(aisle.role).toBe("aisle");
    expect(aisle.gcsPersisted).toBe(true);
  });

  it("reports replayReady from the mediamtx map", () => {
    const out = buildK8sCamerasResponse(desired, [], new Map([["aisle-1", true]]), null);
    expect(out.cameras.find((c) => c.id === "aisle-1")!.feeds[0].replayReady).toBe(true);
  });
});
