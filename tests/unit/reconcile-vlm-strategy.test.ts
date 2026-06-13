import { describe, it, expect } from "vitest";
import { reconcileVlmStrategy } from "@/lib/reconcile/vlm-strategy";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";

function adapter(changed: boolean, throws = false): ClusterAdapter {
  return {
    listSensors: async () => [],
    addSensor: async () => ({ ok: true }),
    ensureDeploymentStrategy: async () => { if (throws) throw new Error("boom"); return changed; },
  } as ClusterAdapter;
}

describe("reconcileVlmStrategy", () => {
  it("patched=true when adapter changed the strategy", async () => {
    const r = await reconcileVlmStrategy(adapter(true), { ns: "vss-alerts", deployment: "vss-rtvi-vlm" });
    expect(r.patched).toBe(true); expect(r.error).toBeUndefined();
  });
  it("patched=false when already Recreate", async () => {
    expect((await reconcileVlmStrategy(adapter(false), { ns: "vss-alerts", deployment: "vss-rtvi-vlm" })).patched).toBe(false);
  });
  it("never throws — records error", async () => {
    const r = await reconcileVlmStrategy(adapter(false, true), { ns: "vss-alerts", deployment: "vss-rtvi-vlm" });
    expect(r.patched).toBe(false); expect(r.error).toMatch(/boom/);
  });
  it("skips when adapter lacks ensureDeploymentStrategy", async () => {
    const a = { listSensors: async () => [], addSensor: async () => ({ ok: true }) } as ClusterAdapter;
    expect((await reconcileVlmStrategy(a, { ns: "x", deployment: "y" })).skipped).toBeDefined();
  });
});
