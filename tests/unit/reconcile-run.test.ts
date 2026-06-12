import { describe, it, expect } from "vitest";
import { reconcileInstanceCameras } from "@/lib/reconcile/run";
import type { ConfigStore, ReconcileStatus, CameraEntry } from "@/lib/config-store/types";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";

function fakeStore(cameras: CameraEntry[]): { store: ConfigStore; written: ReconcileStatus[] } {
  const written: ReconcileStatus[] = [];
  const store: ConfigStore = {
    readCameras: async () => cameras,
    writeCameras: async () => {},
    readStatus: async () => null,
    writeStatus: async (_i, s) => {
      written.push(s);
    },
    readPrompt: async () => null,
    writePrompt: async () => {},
    readScenarios: async () => [],
    writeScenarios: async () => {},
  };
  return { store, written };
}

const cam = (id: string): CameraEntry => ({ id, rtspUrl: `rtsp://x:8554/${id}` });
const FIXED = "2026-06-12T12:00:00.000Z";

describe("reconcileInstanceCameras", () => {
  it("applies desired cameras and writes a status reflecting the run", async () => {
    const { store, written } = fakeStore([cam("aisle-1"), cam("dock-1")]);
    const added: string[] = [];
    const adapter: ClusterAdapter = {
      listSensors: async () => [],
      addSensor: async (name) => {
        added.push(name);
        return { ok: true };
      },
    };
    const status = await reconcileInstanceCameras(store, adapter, "inst-1", {
      prune: false,
      now: () => FIXED,
      agentVersion: "v-test",
    });
    expect(added.sort()).toEqual(["aisle-1", "dock-1"]);
    expect(status.applied.camerasAdded).toBe(2);
    expect(status.lastRunAt).toBe(FIXED);
    expect(status.errors).toEqual([]);
    expect(written).toEqual([status]); // status persisted exactly once
  });

  it("records failed adds in status.errors without throwing", async () => {
    const { store } = fakeStore([cam("aisle-1")]);
    const adapter: ClusterAdapter = {
      listSensors: async () => [],
      addSensor: async () => ({ ok: false, warning: "DESCRIBE failed" }),
    };
    const status = await reconcileInstanceCameras(store, adapter, "inst-1", {
      prune: false,
      now: () => FIXED,
      agentVersion: "v-test",
    });
    expect(status.applied.camerasAdded).toBe(0);
    expect(status.errors).toContain("camera aisle-1: DESCRIBE failed");
  });

  it("captures a thrown listSensors error into status.errors (never throws)", async () => {
    const { store, written } = fakeStore([cam("aisle-1")]);
    const adapter: ClusterAdapter = {
      listSensors: async () => {
        throw new Error("cluster unreachable");
      },
      addSensor: async () => ({ ok: true }),
    };
    const status = await reconcileInstanceCameras(store, adapter, "inst-1", {
      prune: false,
      now: () => FIXED,
      agentVersion: "v-test",
    });
    expect(status.errors[0]).toContain("cluster unreachable");
    expect(written).toEqual([status]);
  });

  it("propagates writeStatus errors (persistence failures are not swallowed)", async () => {
    const store: ConfigStore = {
      readCameras: async () => [cam("aisle-1")],
      writeCameras: async () => {},
      readStatus: async () => null,
      writeStatus: async () => {
        throw new Error("Firestore unavailable");
      },
      readPrompt: async () => null,
      writePrompt: async () => {},
      readScenarios: async () => [],
      writeScenarios: async () => {},
    };
    const adapter: ClusterAdapter = {
      listSensors: async () => [],
      addSensor: async () => ({ ok: true }),
    };
    await expect(
      reconcileInstanceCameras(store, adapter, "inst-1", { prune: false, now: () => FIXED }),
    ).rejects.toThrow("Firestore unavailable");
  });
});
