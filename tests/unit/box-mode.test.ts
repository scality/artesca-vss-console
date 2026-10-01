// The box's GPU mode, read from the AI Factory's ConfigMap, and the write guard
// that follows from it (src/lib/box-mode.ts).
//
// The reader is injected through resetBoxModeCache({ reader }), so nothing here
// reaches a cluster. cluster-refs is the real module with the default env:
// VSS_NAMESPACE unset → vss-base.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  readBoxMode,
  getBoxMode,
  resetBoxModeCache,
  parseModeRecord,
  switchOwnedWorkloads,
  isSwitchOwned,
  assertWorkloadWritable,
  boxPausedResponse,
  BoxPausedError,
  BOX_MODE_TTL_MS,
  type ConfigMapReader,
} from "@/lib/box-mode";

const LLM_RECORD = {
  data: {
    mode: "llm",
    pinned: "true",
    updatedAt: "2026-10-01T10:40:29.227Z",
    updatedBy: "operator@example.com",
    lastOutcome: "healthy",
  },
};

/** The record as the switch first writes it, before any pin key existed. */
const VSS_RECORD_NO_PIN = { data: { mode: "vss", updatedAt: "", lastOutcome: "" } };

const apiError = (code: number) => Object.assign(new Error(`HTTP-Code: ${code}`), { code });
const reader = (impl: ConfigMapReader) => vi.fn(impl);

beforeEach(() => resetBoxModeCache());

describe("readBoxMode — the record", () => {
  it("present: reads mode, pinned and updatedAt from the ConfigMap", async () => {
    const read = reader(async () => LLM_RECORD);
    const m = await readBoxMode({ reader: read });
    expect(m).toEqual({
      mode: "llm",
      pinned: true,
      updatedAt: "2026-10-01T10:40:29.227Z",
      source: "configmap",
      reason: null,
    });
    expect(read).toHaveBeenCalledWith("ai-factory", "gpu-mode");
  });

  it("present: a record without `pinned` reads as unpinned, an empty updatedAt as null", async () => {
    const m = await readBoxMode({ reader: async () => VSS_RECORD_NO_PIN });
    expect(m).toEqual({ mode: "vss", pinned: false, updatedAt: null, source: "configmap", reason: null });
  });

  it("absent: a 404 (no namespace or no ConfigMap) is vss, source absent", async () => {
    const m = await readBoxMode({
      reader: async () => {
        throw apiError(404);
      },
    });
    expect(m.mode).toBe("vss");
    expect(m.source).toBe("absent");
    expect(m.pinned).toBe(false);
    expect(m.reason).toMatch(/not found/);
  });

  it("403: forbidden is vss, source error, and the reason names the permission", async () => {
    const m = await readBoxMode({
      reader: async () => {
        throw Object.assign(new Error("HTTP-Code: 403"), { code: 403, body: '{"reason":"Forbidden"}' });
      },
    });
    expect(m.mode).toBe("vss");
    expect(m.source).toBe("error");
    expect(m.reason).toMatch(/^forbidden: .*ConfigMap ai-factory\/gpu-mode/);
  });

  it.each([
    ["no data", {}],
    ["data is not an object", { data: "mode=llm" }],
    ["no mode key", { data: { pinned: "true" } }],
    ["empty mode", { data: { mode: "  " } }],
    ["mode not a string", { data: { mode: 1 } }],
    ["mode not a mode name", { data: { mode: "llm; rm -rf /" } }],
  ])("malformed (%s): vss, source error, reason says malformed", async (_label, cm) => {
    const m = await readBoxMode({ reader: async () => cm });
    expect(m).toMatchObject({ mode: "vss", pinned: false, updatedAt: null, source: "error" });
    expect(m.reason).toMatch(/^malformed: /);
  });

  it("a read that never answers times out to vss, source error", async () => {
    const m = await readBoxMode({ reader: () => new Promise(() => {}), timeoutMs: 20 });
    expect(m).toMatchObject({ mode: "vss", source: "error" });
    expect(m.reason).toMatch(/timed out/);
  });

  it("any other API failure is vss, source error, with the message", async () => {
    const m = await readBoxMode({
      reader: async () => {
        throw new Error("connect ECONNREFUSED 10.96.0.1:443");
      },
    });
    expect(m).toMatchObject({ mode: "vss", source: "error" });
    expect(m.reason).toContain("ECONNREFUSED");
  });

  it("mode is trimmed and lower-cased", () => {
    expect(parseModeRecord({ data: { mode: " LLM " } }).mode).toBe("llm");
  });
});

describe("getBoxMode — cached", () => {
  it("reuses one read for BOX_MODE_TTL_MS, then reads again", async () => {
    const read = reader(async () => LLM_RECORD);
    resetBoxModeCache({ reader: read });
    let t = 1_000_000;
    const now = () => t;
    expect((await getBoxMode(now)).mode).toBe("llm");
    t += BOX_MODE_TTL_MS - 1;
    await getBoxMode(now);
    expect(read).toHaveBeenCalledTimes(1);
    t += 2;
    await getBoxMode(now);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers share one read", async () => {
    const read = reader(async () => LLM_RECORD);
    resetBoxModeCache({ reader: read });
    await Promise.all([getBoxMode(), getBoxMode(), getBoxMode()]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("the mode changing back to vss is seen once the cache expires", async () => {
    let record: unknown = LLM_RECORD;
    resetBoxModeCache({ reader: async () => record });
    let t = 0;
    expect((await getBoxMode(() => t)).mode).toBe("llm");
    record = VSS_RECORD_NO_PIN;
    t += BOX_MODE_TTL_MS + 1;
    expect((await getBoxMode(() => t)).mode).toBe("vss");
  });
});

describe("the workloads the switch owns", () => {
  it("are the VLM Deployment, the VST recorder and the KV-cache vLLM, in this console's names", () => {
    expect(switchOwnedWorkloads()).toEqual([
      { kind: "Deployment", namespace: "vss-base", name: "vss-rtvi-vlm" },
      { kind: "StatefulSet", namespace: "vss-base", name: "vss-vios-streamprocessing" },
      { kind: "Deployment", namespace: "kvcache-demo", name: "vllm-lmcache" },
    ]);
    expect(isSwitchOwned("vss-base", "alert-worker")).toBe(false);
    expect(isSwitchOwned("vss-base", "vss-agent")).toBe(false);
  });
});

describe("assertWorkloadWritable — the write guard", () => {
  it("refuses an owned workload while the box is in llm mode", async () => {
    resetBoxModeCache({ reader: async () => LLM_RECORD });
    const err = await assertWorkloadWritable("Deployment", "vss-base", "vss-rtvi-vlm").catch((e) => e);
    expect(err).toBeInstanceOf(BoxPausedError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/^VSS paused — the box is running the LLM \(AI Factory\)\./);
    expect(err.message).toContain("deployment/vss-base/vss-rtvi-vlm");
    expect(err.message).toContain("pinned");
  });

  it("allows the same workload in vss mode, and when there is no record", async () => {
    resetBoxModeCache({ reader: async () => VSS_RECORD_NO_PIN });
    await expect(assertWorkloadWritable("Deployment", "vss-base", "vss-rtvi-vlm")).resolves.toBeUndefined();
    resetBoxModeCache({
      reader: async () => {
        throw apiError(404);
      },
    });
    await expect(assertWorkloadWritable("StatefulSet", "vss-base", "vss-vios-streamprocessing")).resolves.toBeUndefined();
  });

  it("does not read the record for a workload the switch does not own", async () => {
    const read = reader(async () => LLM_RECORD);
    resetBoxModeCache({ reader: read });
    await expect(assertWorkloadWritable("Deployment", "vss-base", "alert-worker")).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("boxPausedResponse — the routes' 409", () => {
  it("answers 409 with the message, the mode and the owned workloads only", async () => {
    resetBoxModeCache({ reader: async () => LLM_RECORD });
    const res = await boxPausedResponse([
      { kind: "Deployment", namespace: "vss-base", name: "vss-vios-sensor" },
      { kind: "StatefulSet", namespace: "vss-base", name: "vss-vios-streamprocessing" },
    ]);
    expect(res?.status).toBe(409);
    const body = await res!.json();
    expect(body.paused).toBe(true);
    expect(body.error).toMatch(/^VSS paused — the box is running the LLM \(AI Factory\)/);
    expect(body.boxMode).toMatchObject({ mode: "llm", pinned: true, source: "configmap" });
    expect(body.workloads).toEqual([{ kind: "StatefulSet", namespace: "vss-base", name: "vss-vios-streamprocessing" }]);
    expect(body.aiFactoryUrl).toBe("http://localhost:4090");
  });

  it("is null in vss mode, and null for workloads the switch does not own", async () => {
    resetBoxModeCache({ reader: async () => VSS_RECORD_NO_PIN });
    expect(await boxPausedResponse([{ kind: "Deployment", namespace: "vss-base", name: "vss-rtvi-vlm" }])).toBeNull();
    resetBoxModeCache({ reader: async () => LLM_RECORD });
    expect(await boxPausedResponse([{ kind: "Deployment", namespace: "vss-base", name: "alert-worker" }])).toBeNull();
  });
});
