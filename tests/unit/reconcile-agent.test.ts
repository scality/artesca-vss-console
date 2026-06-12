// console/tests/unit/reconcile-agent.test.ts
import { describe, it, expect, vi } from "vitest";
import { runReconcileAgentOnce } from "@/lib/reconcile-agent";
import type { ConfigStore, ReconcileStatus, CameraEntry } from "@/lib/config-store/types";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";

const cam = (id: string): CameraEntry => ({ id, rtspUrl: `rtsp://x:8554/${id}` });

function fakeStore(cameras: CameraEntry[]): { store: ConfigStore; written: ReconcileStatus[] } {
  const written: ReconcileStatus[] = [];
  return {
    written,
    store: {
      readCameras: async () => cameras,
      writeCameras: async () => {},
      readStatus: async () => null,
      writeStatus: async (_i, s) => { written.push(s); },
    },
  };
}

describe("runReconcileAgentOnce", () => {
  it("reconciles via the injected store + adapter and returns the status", async () => {
    const { store, written } = fakeStore([cam("aisle-1")]);
    const added: string[] = [];
    const adapter: ClusterAdapter = {
      listSensors: async () => [],
      addSensor: async (name) => { added.push(name); return { ok: true }; },
    };
    const logged: string[] = [];
    const status = await runReconcileAgentOnce({
      store, adapter, instance: "inst-1",
      log: { info: (m: string) => logged.push(m), warn: () => {} },
    });
    expect(added).toEqual(["aisle-1"]);
    expect(status.applied.camerasAdded).toBe(1);
    expect(written).toEqual([status]);
    expect(logged.join(" ")).toMatch(/inst-1/);
  });

  it("stamps the agent version into the status", async () => {
    const { store } = fakeStore([]);
    const adapter: ClusterAdapter = { listSensors: async () => [], addSensor: async () => ({ ok: true }) };
    const status = await runReconcileAgentOnce({
      store, adapter, instance: "inst-1", agentVersion: "agent@test",
      log: { info: () => {}, warn: () => {} },
    });
    expect(status.agentVersion).toBe("agent@test");
  });
});
