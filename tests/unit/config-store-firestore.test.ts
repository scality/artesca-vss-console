import { describe, it, expect } from "vitest";
import { FirestoreConfigStore, type FirestoreLike } from "@/lib/config-store/firestore";
import type { CameraEntry, ReconcileStatus, ScenarioEntry } from "@/lib/config-store/types";

/** Minimal in-memory Firestore stub implementing only what the store uses. */
function fakeDb(): FirestoreLike & { dump: () => Record<string, Record<string, unknown>> } {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const docs = new Map<string, Record<string, unknown>>();
  const col = (p: string) => {
    if (!collections.has(p)) collections.set(p, new Map());
    return collections.get(p)!;
  };
  return {
    collection(path: string) {
      const c = col(path);
      return {
        async get() {
          return { docs: [...c.entries()].map(([id, data]) => ({ id, data: () => data })) };
        },
        doc(id: string) {
          return {
            async set(data: Record<string, unknown>) {
              c.set(id, data);
            },
            async delete() {
              c.delete(id);
            },
          };
        },
      };
    },
    doc(path: string) {
      return {
        async get() {
          const data = docs.get(path);
          return { exists: data !== undefined, data: () => data };
        },
        async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
          docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : data);
        },
      };
    },
    dump: () => Object.fromEntries(docs),
  };
}

const cam = (id: string): CameraEntry => ({ id, rtspUrl: `rtsp://x:8554/${id}`, description: id });

describe("FirestoreConfigStore", () => {
  it("writeCameras then readCameras round-trips the desired set", async () => {
    const db = fakeDb();
    const store = new FirestoreConfigStore(db);
    await store.writeCameras("inst-1", [cam("aisle-1"), cam("dock-1")], "stephane");
    const out = await store.readCameras("inst-1");
    expect(out.map((c) => c.id).sort()).toEqual(["aisle-1", "dock-1"]);
    expect(out.find((c) => c.id === "aisle-1")?.rtspUrl).toBe("rtsp://x:8554/aisle-1");
  });

  it("writeCameras replaces the set — removed cameras disappear", async () => {
    const db = fakeDb();
    const store = new FirestoreConfigStore(db);
    await store.writeCameras("inst-1", [cam("a"), cam("b")], "x");
    await store.writeCameras("inst-1", [cam("a")], "x"); // b dropped
    const out = await store.readCameras("inst-1");
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("readStatus returns null when absent, then round-trips after writeStatus", async () => {
    const db = fakeDb();
    const store = new FirestoreConfigStore(db);
    expect(await store.readStatus("inst-1")).toBeNull();
    const status: ReconcileStatus = {
      lastRunAt: "2026-06-12T00:00:00.000Z",
      applied: { camerasAdded: 2, camerasPruned: 0, promptUpdated: false, scenariosUpdated: false },
      drift: [],
      errors: [],
      agentVersion: "v-test",
    };
    await store.writeStatus("inst-1", status);
    expect(await store.readStatus("inst-1")).toEqual(status);
  });

  it("camera docs are keyed by camera id and exclude the redundant id field", async () => {
    const db = fakeDb();
    const store = new FirestoreConfigStore(db);
    await store.writeCameras("inst-1", [cam("aisle-1")], "stephane");
    const out = await store.readCameras("inst-1");
    expect(out[0]).toMatchObject({ id: "aisle-1", rtspUrl: "rtsp://x:8554/aisle-1", description: "aisle-1" });
    // The stored doc must NOT carry a redundant `id` field — id is only the key.
    const raw = await db.collection("instances/inst-1/cameras").get();
    expect(raw.docs[0].data()).not.toHaveProperty("id");
    expect(raw.docs[0].id).toBe("aisle-1");
  });

  it("writeCameras with an empty list evacuates all cameras", async () => {
    const db = fakeDb();
    const store = new FirestoreConfigStore(db);
    await store.writeCameras("inst-1", [cam("a"), cam("b")], "x");
    await store.writeCameras("inst-1", [], "x");
    expect(await store.readCameras("inst-1")).toEqual([]);
  });

  it("readPrompt returns null when absent", async () => {
    const store = new FirestoreConfigStore(fakeDb());
    expect(await store.readPrompt("inst-1")).toBeNull();
  });

  it("writePrompt then readPrompt round-trips without audit fields", async () => {
    const store = new FirestoreConfigStore(fakeDb());
    await store.writePrompt("inst-1", { prompt: "Describe the scene", model: "gpt-4o" }, "stephane");
    const out = await store.readPrompt("inst-1");
    expect(out).toEqual({ prompt: "Describe the scene", model: "gpt-4o" });
    // Audit fields must not bleed into the returned PromptDoc.
    expect(out).not.toHaveProperty("updatedBy");
    expect(out).not.toHaveProperty("updatedAt");
  });

  it("writePrompt without model round-trips correctly (no model key)", async () => {
    const store = new FirestoreConfigStore(fakeDb());
    await store.writePrompt("inst-1", { prompt: "Look for anomalies" }, "bot");
    const out = await store.readPrompt("inst-1");
    expect(out).toEqual({ prompt: "Look for anomalies" });
    expect(out).not.toHaveProperty("model");
  });

  it("writePrompt uses merge — does not clobber reconcileStatus", async () => {
    const db = fakeDb();
    const store = new FirestoreConfigStore(db);
    const status: ReconcileStatus = {
      lastRunAt: "2026-06-12T00:00:00.000Z",
      applied: { camerasAdded: 0, camerasPruned: 0, promptUpdated: false, scenariosUpdated: false },
      drift: [],
      errors: [],
      agentVersion: "v-test",
    };
    await store.writeStatus("inst-1", status);
    await store.writePrompt("inst-1", { prompt: "hello" }, "op");
    // reconcileStatus must survive the merge.
    expect(await store.readStatus("inst-1")).toEqual(status);
  });

  it("readScenarios returns empty array when absent", async () => {
    const store = new FirestoreConfigStore(fakeDb());
    expect(await store.readScenarios("inst-1")).toEqual([]);
  });

  it("writeScenarios then readScenarios round-trips the desired set", async () => {
    const store = new FirestoreConfigStore(fakeDb());
    const scenarios: ScenarioEntry[] = [
      {
        id: "fall",
        name: "Fall Detection",
        severity: "high",
        channels: ["ui"],
        sensor_filter: "*",
        keywords: ["fall", "person down"],
        enabled: true,
      },
      {
        id: "crowd",
        name: "Crowd Alert",
        description: "Too many people",
        severity: "medium",
        channels: ["ui", "slack"],
        sensor_filter: "entrance-*",
        keywords: ["crowd"],
        enabled: false,
        cooldown_seconds: 60,
      },
    ];
    await store.writeScenarios("inst-1", scenarios, "stephane");
    const out = await store.readScenarios("inst-1");
    expect(out.map((s) => s.id).sort()).toEqual(["crowd", "fall"]);
    const fall = out.find((s) => s.id === "fall")!;
    expect(fall.name).toBe("Fall Detection");
    expect(fall.severity).toBe("high");
    expect(fall.enabled).toBe(true);
  });

  it("writeScenarios replaces the set — removed scenarios disappear", async () => {
    const store = new FirestoreConfigStore(fakeDb());
    const base: ScenarioEntry = {
      id: "s1",
      name: "S1",
      severity: "low",
      channels: ["ui"],
      sensor_filter: "*",
      keywords: ["x"],
      enabled: true,
    };
    const extra: ScenarioEntry = { ...base, id: "s2", name: "S2" };
    await store.writeScenarios("inst-1", [base, extra], "x");
    await store.writeScenarios("inst-1", [base], "x"); // s2 dropped
    const out = await store.readScenarios("inst-1");
    expect(out.map((s) => s.id)).toEqual(["s1"]);
  });

  it("writeScenarios with an empty list evacuates all scenarios", async () => {
    const store = new FirestoreConfigStore(fakeDb());
    const base: ScenarioEntry = {
      id: "s1",
      name: "S1",
      severity: "low",
      channels: ["ui"],
      sensor_filter: "*",
      keywords: ["x"],
      enabled: true,
    };
    await store.writeScenarios("inst-1", [base], "x");
    await store.writeScenarios("inst-1", [], "x");
    expect(await store.readScenarios("inst-1")).toEqual([]);
  });

  it("scenario docs are keyed by scenario id and exclude the redundant id field", async () => {
    const db = fakeDb();
    const store = new FirestoreConfigStore(db);
    const s: ScenarioEntry = {
      id: "fall",
      name: "Fall",
      severity: "high",
      channels: ["ui"],
      sensor_filter: "*",
      keywords: ["fall"],
      enabled: true,
    };
    await store.writeScenarios("inst-1", [s], "x");
    const raw = await db.collection("instances/inst-1/scenarios").get();
    expect(raw.docs[0].id).toBe("fall");
    expect((raw.docs[0].data() as Record<string, unknown>).id).toBeUndefined();
  });
});
