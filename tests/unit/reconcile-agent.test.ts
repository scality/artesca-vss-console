// console/tests/unit/reconcile-agent.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runReconcileAgentOnce, startReconcileLoop } from "@/lib/reconcile-agent";
import { makeFirestoreConfigStore } from "@/lib/config-store/firestore";
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
      upsertCamera: async () => {},
      deleteCamera: async () => {},
      readStatus: async () => null,
      writeStatus: async (_i, s) => { written.push(s); },
      readPrompt: async () => null,
      writePrompt: async () => {},
      readScenarios: async () => [],
      writeScenarios: async () => {},
      readPromptSets: async () => [],
      upsertPromptSet: async () => {},
      deletePromptSet: async () => {},
      readActivePromptId: async () => null,
      setActivePromptId: async () => {},
    },
  };
}

vi.mock("@/lib/config-store/firestore", () => ({
  makeFirestoreConfigStore: vi.fn(async () => ({
    readCameras: async () => [], writeCameras: async () => {}, upsertCamera: async () => {},
    deleteCamera: async () => {}, readStatus: async () => null, writeStatus: async () => {},
    readPrompt: async () => null, writePrompt: async () => {}, readScenarios: async () => [],
    writeScenarios: async () => {}, readPromptSets: async () => [], upsertPromptSet: async () => {},
    deletePromptSet: async () => {}, readActivePromptId: async () => null, setActivePromptId: async () => {},
  })),
}));
vi.mock("@/lib/reconcile/cluster-adapter", () => ({
  VstClusterAdapter: class { listSensors = async () => []; addSensor = async () => ({ ok: true }); },
}));
vi.mock("@/lib/cluster-refs", () => ({ CLUSTER: {} }));
vi.mock("@/lib/reconcile/refs", () => ({ buildReconcileRefs: () => ({}) }));
vi.mock("@/lib/helpers/default-prompt", () => ({ readDefaultPrompt: () => "p" }));
vi.mock("@/lib/reconcile/prompt-seed", () => ({ seedDefaultPromptSet: async () => {} }));

describe("startReconcileLoop periodic gating", () => {
  beforeEach(() => {
    // clearAllMocks resets call counts on vi.fn() mocks (e.g. makeFirestoreConfigStore)
    // and clears spy call history — both are needed for count isolation across tests.
    vi.clearAllMocks();
    process.env.VSS_INSTANCE_NAME = "inst-1";
  });

  it("periodic:false runs one pass and schedules NO interval", async () => {
    const spy = vi.spyOn(global, "setInterval");
    await startReconcileLoop({ periodic: false });
    expect(spy).not.toHaveBeenCalled();
    // Verify the startup convergence pass fired: makeFirestoreConfigStore is called
    // exactly once per startReconcileLoop invocation (before tick() is enqueued).
    expect(vi.mocked(makeFirestoreConfigStore)).toHaveBeenCalledTimes(1);
  });

  it("periodic:true (default) schedules the interval", async () => {
    const spy = vi.spyOn(global, "setInterval").mockReturnValue(0 as never);
    await startReconcileLoop({ periodic: true, intervalMs: 60000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 60000);
  });
});

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
