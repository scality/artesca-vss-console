// The reconcile pass while the AI Factory has the box in another GPU mode:
// one `paused:` line, no write to the VLM Deployment (prompt, strategy), no
// recording-recovery pass — and cameras and scenarios still converge.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConfigStore, ReconcileStatus } from "@/lib/config-store/types";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import type { BoxMode } from "@/lib/box-mode";

const recover = vi.hoisted(() => vi.fn(async () => ({ outcomes: [], reArmed: [], degraded: [], escalated: false })));
const listSensors = vi.hoisted(() => vi.fn(async () => ({ sensors: [] })));

vi.mock("@/lib/cluster-refs", () => ({ CLUSTER: { recording: { enabled: true } } }));
vi.mock("@/lib/reconcile/recording-recovery", () => ({ recoverStalledRecording: recover }));
vi.mock("@/lib/helpers/vst", () => ({ vstListSensors: listSensors }));
vi.mock("@/lib/helpers/recording-health", () => ({ probeRecording: vi.fn() }));
vi.mock("@/lib/helpers/rearm-recording", () => ({ rearmRecording: vi.fn() }));
vi.mock("@/lib/helpers/rtsp-probe", () => ({ rtspSourceAnswers: vi.fn() }));
vi.mock("@/lib/reconcile/cluster-adapter", () => ({
  VstClusterAdapter: class {
    restartStreamProcessing = async () => {};
  },
}));

import { runReconcileAgentOnce } from "@/lib/reconcile-agent";

const LLM: BoxMode = { mode: "llm", pinned: false, updatedAt: "2026-10-01T10:40:29.227Z", source: "configmap", reason: null };
const VSS: BoxMode = { mode: "vss", pinned: false, updatedAt: null, source: "absent", reason: "no record" };

const REFS = {
  prompt: { ns: "vss-alerts", deployment: "vss-rtvi-vlm", promptKey: "VLM_SYSTEM_PROMPT" },
  scenarios: { ns: "vss-alerts", configMap: "scenarios", yamlKey: "scenarios.yaml", alertWorkerDeployment: "alert-worker" },
};

function store(): ConfigStore {
  return {
    readCameras: async () => [{ id: "aisle-1", rtspUrl: "rtsp://x:8554/aisle-1" }],
    writeCameras: async () => {},
    upsertCamera: async () => {},
    deleteCamera: async () => {},
    readStatus: async () => null,
    writeStatus: async (_i: string, _s: ReconcileStatus) => {},
    readPrompt: async () => ({ prompt: "desired prompt" }),
    writePrompt: async () => {},
    readScenarios: async () => [{ id: "s1", name: "S1", severity: "high", channels: [], sensor_filter: "*", keywords: ["x"], enabled: true }] as never,
    writeScenarios: async () => {},
    readPromptSets: async () => [],
    upsertPromptSet: async () => {},
    deletePromptSet: async () => {},
    readActivePromptId: async () => null,
    setActivePromptId: async () => {},
  };
}

function adapter() {
  const calls = { added: [] as string[], envPatched: 0, restarted: [] as string[], strategy: 0, cmPatched: 0 };
  const a: ClusterAdapter = {
    listSensors: async () => [],
    addSensor: async (name) => {
      calls.added.push(name);
      return { ok: true };
    },
    getDeploymentEnv: async () => "live prompt",
    patchDeploymentEnv: async () => {
      calls.envPatched += 1;
    },
    restartDeployment: async (_ns, d) => {
      calls.restarted.push(d);
    },
    ensureDeploymentStrategy: async () => {
      calls.strategy += 1;
      return true;
    },
    getConfigMapKey: async () => "old",
    patchConfigMapKey: async () => {
      calls.cmPatched += 1;
    },
  };
  return { a, calls };
}

beforeEach(() => {
  recover.mockClear();
  listSensors.mockClear();
});

describe("runReconcileAgentOnce while the box is in llm mode", () => {
  it("logs one paused line, skips the VLM writes and recording-recovery, converges the rest", async () => {
    const { a, calls } = adapter();
    const logged: string[] = [];
    const status = await runReconcileAgentOnce({
      store: store(),
      adapter: a,
      instance: "inst-1",
      refs: REFS,
      boxMode: async () => LLM,
      log: { info: (m) => logged.push(m), warn: (m) => logged.push(`WARN ${m}`) },
    });

    const pausedLines = logged.filter((l) => l.startsWith("paused: box in llm mode"));
    expect(pausedLines).toHaveLength(1);
    // Nothing written to the VLM Deployment.
    expect(calls.envPatched).toBe(0);
    expect(calls.strategy).toBe(0);
    expect(calls.restarted).not.toContain("vss-rtvi-vlm");
    expect(status.applied.promptUpdated).toBe(false);
    expect(status.drift.join(" ")).toMatch(/prompt: differs from desired — paused: box in llm mode/);
    // No recording-recovery pass at all.
    expect(listSensors).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    // Cameras and scenarios still converge.
    expect(calls.added).toEqual(["aisle-1"]);
    expect(calls.cmPatched).toBe(1);
    expect(calls.restarted).toEqual(["alert-worker"]);
  });

  it("in vss mode writes the prompt and runs recording-recovery, with no paused line", async () => {
    const { a, calls } = adapter();
    const logged: string[] = [];
    await runReconcileAgentOnce({
      store: store(),
      adapter: a,
      instance: "inst-1",
      refs: REFS,
      boxMode: async () => VSS,
      log: { info: (m) => logged.push(m), warn: (m) => logged.push(`WARN ${m}`) },
    });
    expect(logged.some((l) => l.startsWith("paused:"))).toBe(false);
    expect(calls.envPatched).toBe(1);
    expect(calls.strategy).toBe(1);
    expect(calls.restarted).toContain("vss-rtvi-vlm");
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("a mode reader that rejects is treated as vss (never pauses on its own failure)", async () => {
    const { a, calls } = adapter();
    await runReconcileAgentOnce({
      store: store(),
      adapter: a,
      instance: "inst-1",
      refs: REFS,
      boxMode: async () => {
        throw new Error("boom");
      },
      log: { info: () => {}, warn: () => {} },
    });
    expect(calls.envPatched).toBe(1);
    expect(recover).toHaveBeenCalledTimes(1);
  });
});
