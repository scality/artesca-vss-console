import { describe, it, expect } from "vitest";
import { reconcileRealtime } from "@/lib/reconcile/realtime";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import type { CameraEntry, PromptSet } from "@/lib/config-store/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RTSP = (id: string) => `rtsp://host:8554/${id}`;

const cam = (id: string, promptId?: string): CameraEntry => ({
  id,
  rtspUrl: RTSP(id),
  ...(promptId !== undefined ? { promptId } : {}),
});

const ps = (id: string, text: string, alertType?: string, model?: string): PromptSet => ({
  id,
  name: `PromptSet-${id}`,
  text,
  ...(alertType !== undefined ? { alertType } : {}),
  ...(model !== undefined ? { model } : {}),
});

/** A rule as returned by listRealtimeRules (camelCase, normalised). */
const rule = (id: string, camId: string, alertType: string, prompt: string) => ({
  id,
  liveStreamUrl: RTSP(camId),
  alertType,
  prompt,
});

interface FakeAdapterOpts {
  currentRules?: { id: string; liveStreamUrl: string; alertType: string; prompt?: string }[];
  capable?: boolean;
}

function fakeAdapter(opts: FakeAdapterOpts = {}) {
  const calls = {
    added: [] as Parameters<NonNullable<ClusterAdapter["addRealtimeRule"]>>[0][],
    deleted: [] as string[],
    listed: 0,
  };

  if (opts.capable === false) {
    const adapter: ClusterAdapter = { listSensors: async () => [], addSensor: async () => ({ ok: true }) };
    return { adapter, calls };
  }

  const currentRules = opts.currentRules ?? [];

  const adapter: ClusterAdapter = {
    listSensors: async () => [],
    addSensor: async () => ({ ok: true }),
    listRealtimeRules: async () => {
      calls.listed++;
      return currentRules;
    },
    addRealtimeRule: async (input) => {
      calls.added.push(input);
      return { ok: true, id: `new-${input.streamUrl}` };
    },
    deleteRealtimeRule: async (id) => {
      calls.deleted.push(id);
      return { ok: true };
    },
  };
  return { adapter, calls };
}

const REFS = { liveStreamUrlFor: (c: CameraEntry) => c.rtspUrl };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reconcileRealtime", () => {
  it("new binding → addRealtimeRule called, applied=1", async () => {
    const { adapter, calls } = fakeAdapter({ currentRules: [] });
    const cameras = [cam("aisle-1", "ps1")];
    const promptSets = [ps("ps1", "Look for theft", "theft-detection")];

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    expect(res.applied).toBe(1);
    expect(res.removed).toBe(0);
    expect(res.errors).toEqual([]);
    expect(calls.added).toHaveLength(1);
    expect(calls.added[0]).toMatchObject({
      streamUrl: RTSP("aisle-1"),
      alertType: "theft-detection",
      prompt: "Look for theft",
      sensorName: "aisle-1",
    });
    expect(calls.deleted).toHaveLength(0);
  });

  it("unbound camera (no promptId) → not POSTed", async () => {
    const { adapter, calls } = fakeAdapter({ currentRules: [] });
    const cameras = [cam("aisle-1")]; // no promptId
    const promptSets = [ps("ps1", "unused")];

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    expect(res.applied).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.errors).toEqual([]);
    expect(calls.added).toHaveLength(0);
  });

  it("changed prompt (existing rule, different text) → delete(old id)+add, applied=1", async () => {
    const existing = [rule("rule-42", "aisle-1", "theft-detection", "old prompt text")];
    const { adapter, calls } = fakeAdapter({ currentRules: existing });
    const cameras = [cam("aisle-1", "ps1")];
    const promptSets = [ps("ps1", "new prompt text", "theft-detection")];

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    expect(res.applied).toBe(1);
    expect(res.removed).toBe(0);
    expect(res.errors).toEqual([]);
    expect(calls.deleted).toContain("rule-42");
    expect(calls.added).toHaveLength(1);
    expect(calls.added[0].prompt).toBe("new prompt text");
  });

  it("unchanged (existing rule matches) → no add/delete, applied=0", async () => {
    const existing = [rule("rule-7", "aisle-1", "theft-detection", "exact prompt")];
    const { adapter, calls } = fakeAdapter({ currentRules: existing });
    const cameras = [cam("aisle-1", "ps1")];
    const promptSets = [ps("ps1", "exact prompt", "theft-detection")];

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    expect(res.applied).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.errors).toEqual([]);
    expect(calls.added).toHaveLength(0);
    expect(calls.deleted).toHaveLength(0);
  });

  it("binding removed (camera now unbound but a current rule exists for its managed stream) → delete, removed=1", async () => {
    // The camera exists in console but has no promptId (binding was cleared).
    const existing = [rule("rule-99", "aisle-1", "theft-detection", "old prompt")];
    const { adapter, calls } = fakeAdapter({ currentRules: existing });
    const cameras = [cam("aisle-1")]; // promptId cleared
    const promptSets = [ps("ps1", "old prompt", "theft-detection")];

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    expect(res.removed).toBe(1);
    expect(res.applied).toBe(0);
    expect(res.errors).toEqual([]);
    expect(calls.deleted).toContain("rule-99");
    expect(calls.added).toHaveLength(0);
  });

  it("a current rule for a stream NOT belonging to any console camera → left untouched (not deleted)", async () => {
    // rule-X is for a stream that is NOT in the console camera list
    const existing = [
      rule("rule-X", "foreign-cam", "some-type", "some prompt"),
      rule("rule-Y", "aisle-1", "theft", "prompt-y"),
    ];
    const { adapter, calls } = fakeAdapter({ currentRules: existing });
    const cameras = [cam("aisle-1", "ps1")];
    const promptSets = [ps("ps1", "prompt-y", "theft")];

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    // aisle-1 rule matches → no-op; foreign-cam rule → not touched
    expect(res.applied).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.errors).toEqual([]);
    expect(calls.deleted).toHaveLength(0);
    expect(calls.added).toHaveLength(0);
  });

  it("prompt-set id not found → error recorded, no POST", async () => {
    const { adapter, calls } = fakeAdapter({ currentRules: [] });
    const cameras = [cam("aisle-1", "missing-ps")];
    const promptSets: PromptSet[] = [];

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    expect(res.applied).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain("aisle-1");
    expect(res.errors[0]).toContain("missing-ps");
    expect(calls.added).toHaveLength(0);
  });

  it("adapter missing methods → skipped", async () => {
    const { adapter } = fakeAdapter({ capable: false });
    const cameras = [cam("aisle-1", "ps1")];
    const promptSets = [ps("ps1", "Look for theft")];

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    expect(res.applied).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.errors).toEqual([]);
    expect(res.skipped).toBeTruthy();
    expect(res.skipped).toContain("adapter cannot drive realtime");
  });

  it("alertType falls back to set.name when alertType is absent", async () => {
    const { adapter, calls } = fakeAdapter({ currentRules: [] });
    const cameras = [cam("cam-1", "ps-no-type")];
    // no alertType field on the prompt set → should fall back to name
    const promptSets: PromptSet[] = [{ id: "ps-no-type", name: "FallbackName", text: "detect something" }];

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    expect(res.applied).toBe(1);
    expect(calls.added[0].alertType).toBe("FallbackName");
  });

  it("fail-soft: thrown adapter call captured per-entry, does not abort", async () => {
    const cameras = [cam("cam-a", "ps1"), cam("cam-b", "ps2")];
    const promptSets = [ps("ps1", "prompt-a", "type-a"), ps("ps2", "prompt-b", "type-b")];

    let callCount = 0;
    const adapter: ClusterAdapter = {
      listSensors: async () => [],
      addSensor: async () => ({ ok: true }),
      listRealtimeRules: async () => [],
      addRealtimeRule: async (input) => {
        callCount++;
        if (input.sensorName === "cam-a") throw new Error("network blip");
        return { ok: true };
      },
      deleteRealtimeRule: async () => ({ ok: true }),
    };

    const res = await reconcileRealtime(cameras, promptSets, adapter, REFS);

    // cam-b succeeds; cam-a throws
    expect(res.applied).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain("cam-a");
    expect(res.errors[0]).toContain("network blip");
    expect(callCount).toBe(2);
  });
});
