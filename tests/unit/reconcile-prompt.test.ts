import { describe, it, expect } from "vitest";
import { reconcilePrompt } from "@/lib/reconcile/prompt";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import type { PromptDoc } from "@/lib/config-store/types";

const REFS = { ns: "vss-alerts", deployment: "vss-rtvi-vlm", promptKey: "VLM_SYSTEM_PROMPT" };

function fakeAdapter(currentEnv: string | null, opts: { capable?: boolean } = { capable: true }) {
  const calls = { patched: [] as { key: string; value: string }[], restarted: [] as string[] };
  const base: ClusterAdapter = { listSensors: async () => [], addSensor: async () => ({ ok: true }) };
  if (opts.capable === false) return { adapter: base, calls };
  const adapter: ClusterAdapter = {
    ...base,
    getDeploymentEnv: async () => currentEnv,
    patchDeploymentEnv: async (_ns, _d, key, value) => { calls.patched.push({ key, value }); },
    restartDeployment: async (_ns, d) => { calls.restarted.push(d); },
  };
  return { adapter, calls };
}

describe("reconcilePrompt", () => {
  it("patches + restarts when the live prompt differs", async () => {
    const { adapter, calls } = fakeAdapter("old prompt");
    const r = await reconcilePrompt({ prompt: "new prompt" }, adapter, REFS);
    expect(r.updated).toBe(true);
    expect(calls.patched).toEqual([{ key: "VLM_SYSTEM_PROMPT", value: "new prompt" }]);
    expect(calls.restarted).toEqual(["vss-rtvi-vlm"]);
  });
  it("no-op when the live prompt already equals desired", async () => {
    const { adapter, calls } = fakeAdapter("same");
    const r = await reconcilePrompt({ prompt: "same" }, adapter, REFS);
    expect(r.updated).toBe(false);
    expect(calls.patched).toEqual([]);
    expect(calls.restarted).toEqual([]);
  });
  it("skips when desired prompt is null", async () => {
    const { adapter } = fakeAdapter("x");
    const r = await reconcilePrompt(null, adapter, REFS);
    expect(r.updated).toBe(false);
    expect(r.skipped).toBeTruthy();
  });
  it("skips when the adapter lacks the deployment-env ops", async () => {
    const { adapter } = fakeAdapter(null, { capable: false });
    const r = await reconcilePrompt({ prompt: "x" }, adapter, REFS);
    expect(r.updated).toBe(false);
    expect(r.skipped).toBeTruthy();
  });
  // The AI Factory GPU switch owns the VLM Deployment while the box is not in
  // `vss` mode (src/lib/box-mode.ts): the live value is still read, nothing is
  // written, and the diff is reported as deferred for the next unpaused pass.
  it("paused: reads the live prompt but neither patches nor restarts", async () => {
    const { adapter, calls } = fakeAdapter("old prompt");
    const r = await reconcilePrompt({ prompt: "new prompt" }, adapter, REFS, { paused: "paused: box in llm mode" });
    expect(r).toEqual({ updated: false, skipped: "paused: box in llm mode", deferred: true });
    expect(calls.patched).toEqual([]);
    expect(calls.restarted).toEqual([]);
  });
  it("paused with the live prompt already desired: a plain no-op, nothing deferred", async () => {
    const { adapter, calls } = fakeAdapter("same");
    const r = await reconcilePrompt({ prompt: "same" }, adapter, REFS, { paused: "paused: box in llm mode" });
    expect(r).toEqual({ updated: false });
    expect(calls.patched).toEqual([]);
  });
  it("unpaused again (paused: null): the deferred write lands", async () => {
    const { adapter, calls } = fakeAdapter("old prompt");
    const r = await reconcilePrompt({ prompt: "new prompt" }, adapter, REFS, { paused: null });
    expect(r.updated).toBe(true);
    expect(calls.patched).toEqual([{ key: "VLM_SYSTEM_PROMPT", value: "new prompt" }]);
    expect(calls.restarted).toEqual(["vss-rtvi-vlm"]);
  });
  it("captures a thrown error (never throws)", async () => {
    const adapter: ClusterAdapter = {
      listSensors: async () => [], addSensor: async () => ({ ok: true }),
      getDeploymentEnv: async () => { throw new Error("k8s down"); },
      patchDeploymentEnv: async () => {}, restartDeployment: async () => {},
    };
    const r = await reconcilePrompt({ prompt: "x" }, adapter, REFS);
    expect(r.updated).toBe(false);
    expect(r.error).toContain("k8s down");
  });
});
