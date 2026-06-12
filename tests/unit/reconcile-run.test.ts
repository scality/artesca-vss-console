import { describe, it, expect } from "vitest";
import { reconcileInstanceCameras } from "@/lib/reconcile/run";
import type { ConfigStore, ReconcileStatus, CameraEntry, ScenarioEntry } from "@/lib/config-store/types";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import type { PromptRefs } from "@/lib/reconcile/prompt";
import type { ScenarioRefs } from "@/lib/reconcile/scenarios";

function fakeStore(cameras: CameraEntry[]): { store: ConfigStore; written: ReconcileStatus[] } {
  const written: ReconcileStatus[] = [];
  const store: ConfigStore = {
    readCameras: async () => cameras,
    writeCameras: async () => {},
    upsertCamera: async () => {},
    deleteCamera: async () => {},
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
      upsertCamera: async () => {},
      deleteCamera: async () => {},
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

  it("converges prompt + scenarios when refs are provided and values differ", async () => {
    const oneScenario: ScenarioEntry = {
      id: "s1",
      name: "Test scenario",
      severity: "medium",
      channels: ["ui"],
      sensor_filter: "*",
      keywords: ["theft"],
      enabled: true,
    };
    const store: ConfigStore = {
      readCameras: async () => [],
      writeCameras: async () => {},
      upsertCamera: async () => {},
      deleteCamera: async () => {},
      readStatus: async () => null,
      writeStatus: async () => {},
      readPrompt: async () => ({ prompt: "New prompt text" }),
      writePrompt: async () => {},
      readScenarios: async () => [oneScenario],
      writeScenarios: async () => {},
    };

    const promptRefs: PromptRefs = { ns: "vss-base", deployment: "vss-rtvi-vlm", promptKey: "VLM_SYSTEM_PROMPT" };
    const scenarioRefs: ScenarioRefs = {
      ns: "pyramid-ingress",
      configMap: "scenarios",
      yamlKey: "scenarios.yaml",
      alertWorkerDeployment: "vss-video-analytics-api",
    };

    const patched: string[] = [];
    const restarted: string[] = [];
    const adapter: ClusterAdapter = {
      listSensors: async () => [],
      addSensor: async () => ({ ok: true }),
      getDeploymentEnv: async () => "old prompt value",
      patchDeploymentEnv: async (_ns, _dep, _key, _val) => { patched.push("prompt"); },
      getConfigMapKey: async () => null,
      patchConfigMapKey: async () => { patched.push("scenarios"); },
      restartDeployment: async (_ns, dep) => { restarted.push(dep); },
    };

    const status = await reconcileInstanceCameras(store, adapter, "inst-1", {
      prune: false,
      now: () => FIXED,
      agentVersion: "v-test",
      refs: { prompt: promptRefs, scenarios: scenarioRefs },
    });

    expect(status.applied.promptUpdated).toBe(true);
    expect(status.applied.scenariosUpdated).toBe(true);
    expect(status.errors).toEqual([]);
    expect(patched).toContain("prompt");
    expect(patched).toContain("scenarios");
    expect(restarted).toContain("vss-rtvi-vlm");
    expect(restarted).toContain("vss-video-analytics-api");
  });

  it("leaves promptUpdated + scenariosUpdated false when no refs are passed (back-compat)", async () => {
    const { store } = fakeStore([cam("cam-1")]);
    const adapter: ClusterAdapter = {
      listSensors: async () => [],
      addSensor: async () => ({ ok: true }),
    };
    const status = await reconcileInstanceCameras(store, adapter, "inst-1", {
      prune: false,
      now: () => FIXED,
    });
    expect(status.applied.promptUpdated).toBe(false);
    expect(status.applied.scenariosUpdated).toBe(false);
    expect(status.applied.camerasAdded).toBe(1);
  });
});
