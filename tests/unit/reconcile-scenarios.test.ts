import { describe, it, expect } from "vitest";
import { reconcileScenarios } from "@/lib/reconcile/scenarios";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import type { ScenarioEntry } from "@/lib/config-store/types";

const REFS = { ns: "pyramid-ingress", configMap: "scenarios", yamlKey: "scenarios.yaml", alertWorkerDeployment: "vss-video-analytics-api" };
// deterministic serializer for the test (no yaml dependency in the test)
const serialize = (s: ScenarioEntry[]) => JSON.stringify(s.map((x) => x.id));
const sc = (id: string): ScenarioEntry => ({ id, name: id, severity: "low", channels: ["ui"], sensor_filter: "*", keywords: [id], enabled: true });

function fakeAdapter(currentRaw: string | null, opts: { capable?: boolean } = { capable: true }) {
  const calls = { patched: [] as string[], restarted: [] as string[] };
  const base: ClusterAdapter = { listSensors: async () => [], addSensor: async () => ({ ok: true }) };
  if (opts.capable === false) return { adapter: base, calls };
  const adapter: ClusterAdapter = {
    ...base,
    getConfigMapKey: async () => currentRaw,
    patchConfigMapKey: async (_ns, _cm, _k, value) => { calls.patched.push(value); },
    restartDeployment: async (_ns, d) => { calls.restarted.push(d); },
  };
  return { adapter, calls };
}

describe("reconcileScenarios", () => {
  it("patches + restarts when the serialized desired differs from live", async () => {
    const { adapter, calls } = fakeAdapter(serialize([sc("a")]));
    const r = await reconcileScenarios([sc("a"), sc("b")], adapter, REFS, serialize);
    expect(r.updated).toBe(true);
    expect(calls.patched).toEqual([serialize([sc("a"), sc("b")])]);
    expect(calls.restarted).toEqual(["vss-video-analytics-api"]);
  });
  it("no-op when serialized desired equals live", async () => {
    const desired = [sc("a")];
    const { adapter, calls } = fakeAdapter(serialize(desired));
    const r = await reconcileScenarios(desired, adapter, REFS, serialize);
    expect(r.updated).toBe(false);
    expect(calls.patched).toEqual([]);
    expect(calls.restarted).toEqual([]);
  });
  it("skips when the adapter lacks the configmap ops", async () => {
    const { adapter } = fakeAdapter(null, { capable: false });
    const r = await reconcileScenarios([sc("a")], adapter, REFS, serialize);
    expect(r.updated).toBe(false);
    expect(r.skipped).toBeTruthy();
  });
  it("captures a thrown error (never throws)", async () => {
    const adapter: ClusterAdapter = {
      listSensors: async () => [], addSensor: async () => ({ ok: true }),
      getConfigMapKey: async () => { throw new Error("cm read failed"); },
      patchConfigMapKey: async () => {}, restartDeployment: async () => {},
    };
    const r = await reconcileScenarios([sc("a")], adapter, REFS, serialize);
    expect(r.updated).toBe(false);
    expect(r.error).toContain("cm read failed");
  });
});
