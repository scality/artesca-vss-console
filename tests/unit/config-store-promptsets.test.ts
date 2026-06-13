import { describe, it, expect } from "vitest";
import { FirestoreConfigStore, type FirestoreLike } from "@/lib/config-store/firestore";

function fakeDb(): FirestoreLike {
  const cols = new Map<string, Map<string, Record<string, unknown>>>();
  const docs = new Map<string, Record<string, unknown>>();
  const col = (p: string) => { if (!cols.has(p)) cols.set(p, new Map()); return cols.get(p)!; };
  return {
    collection(path: string) {
      const c = col(path);
      return {
        async get() { return { docs: [...c.entries()].map(([id, data]) => ({ id, data: () => data })) }; },
        doc(id: string) { return { async set(d: Record<string, unknown>) { c.set(id, d); }, async delete() { c.delete(id); } }; },
      };
    },
    doc(path: string) {
      return {
        async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
        async set(d: Record<string, unknown>, o?: { merge?: boolean }) { docs.set(path, o?.merge ? { ...(docs.get(path) ?? {}), ...d } : d); },
      };
    },
  };
}

describe("prompt-sets", () => {
  it("upsert + list + delete + active id round-trip", async () => {
    const s = new FirestoreConfigStore(fakeDb());
    await s.upsertPromptSet("i1", { id: "retail", name: "Retail LP", text: "watch checkout" }, "op");
    await s.upsertPromptSet("i1", { id: "warehouse", name: "Warehouse", text: "watch forklifts" }, "op");
    expect((await s.readPromptSets("i1")).map((p) => p.id).sort()).toEqual(["retail", "warehouse"]);
    await s.setActivePromptId("i1", "warehouse", "op");
    expect(await s.readActivePromptId("i1")).toBe("warehouse");
    await s.deletePromptSet("i1", "retail", "op");
    expect((await s.readPromptSets("i1")).map((p) => p.id)).toEqual(["warehouse"]);
  });
  it("readPrompt resolves the ACTIVE set's text/model", async () => {
    const s = new FirestoreConfigStore(fakeDb());
    await s.upsertPromptSet("i1", { id: "a", name: "A", text: "prompt-A", model: "m" }, "op");
    await s.setActivePromptId("i1", "a", "op");
    expect(await s.readPrompt("i1")).toEqual({ prompt: "prompt-A", model: "m" });
  });
  it("readPrompt falls back to the legacy single prompt when no active set", async () => {
    const s = new FirestoreConfigStore(fakeDb());
    await s.writePrompt("i1", { prompt: "legacy" }, "op");
    expect(await s.readPrompt("i1")).toEqual({ prompt: "legacy" });
  });
});
