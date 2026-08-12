// ISVD-606. One suite, run against BOTH config-store backends.
//
// The point is not coverage of either implementation; it is that they cannot
// disagree. The store is swapped by an environment variable on a live showroom,
// so a difference in semantics shows up as an operator's camera edit doing
// something else after a redeploy — with nothing failing.
//
// Two of the properties below are the ones that were actually at risk, and both
// come from the same place: Firestore's `set()` without `{merge:true}` REPLACES a
// document, and `src/app/api/cameras/[id]/route.ts` relies on it. Unbinding a
// prompt or clearing a scenario override is expressed there as `delete`ing the key
// from the object it then upserts, so a file store that merged fields would keep
// the old value and make "unbind" a silent no-op.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { FileConfigStore, ConfigFileError, configFilePath } from "@/lib/config-store/file";
import { FirestoreConfigStore, type FirestoreLike } from "@/lib/config-store/firestore";
import type { ConfigStore, CameraEntry, ScenarioEntry, PromptSet } from "@/lib/config-store/types";
import { emptyStatus } from "@/lib/config-store/types";

// ─── An in-memory Firestore that behaves like the real one ───────────────────
// Only the slice FirestoreConfigStore uses. The two behaviours that matter are
// `doc().set(data, {merge:true})` merging top-level keys and `set(data)` without
// it replacing the document — the same distinction the file store has to honour.
function fakeFirestore(): FirestoreLike {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    collection(collPath: string) {
      const prefix = `${collPath}/`;
      return {
        async get() {
          return {
            docs: [...docs.entries()]
              .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
              .map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v })),
          };
        },
        doc(id: string) {
          const key = `${prefix}${id}`;
          return {
            async set(data: Record<string, unknown>) {
              docs.set(key, { ...data }); // no merge — whole-document replace
              return undefined;
            },
            async delete() {
              docs.delete(key);
              return undefined;
            },
          };
        },
      };
    },
    doc(docPath: string) {
      return {
        async get() {
          const v = docs.get(docPath);
          return { exists: v !== undefined, data: () => v };
        },
        async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
          const prev = opts?.merge ? (docs.get(docPath) ?? {}) : {};
          docs.set(docPath, { ...prev, ...data });
          return undefined;
        },
      };
    },
  };
}

const INSTANCE = "ap-vss-val-4";
const cam = (id: string, extra: Partial<CameraEntry> = {}): CameraEntry => ({
  id,
  rtspUrl: `rtsp://cams:8554/${id}`,
  ...extra,
});
const scenario = (id: string): ScenarioEntry => ({
  id,
  name: id,
  severity: "medium",
  channels: ["ui"],
  sensor_filter: "*",
  keywords: ["k"],
  enabled: true,
});
const promptSet = (id: string, text = "watch the door"): PromptSet => ({ id, name: id, text });

interface Backend {
  name: string;
  make: () => Promise<ConfigStore>;
  cleanup: () => Promise<void>;
}

const backends: Backend[] = [
  {
    name: "file",
    make: async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cfgstore-"));
      dirs.push(dir);
      return new FileConfigStore(dir);
    },
    cleanup: async () => {
      for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
    },
  },
  {
    name: "firestore",
    make: async () => new FirestoreConfigStore(fakeFirestore()),
    cleanup: async () => {},
  },
];
const dirs: string[] = [];

for (const backend of backends) {
  describe(`ConfigStore contract — ${backend.name}`, () => {
    let store: ConfigStore;
    beforeEach(async () => {
      store = await backend.make();
    });
    afterEach(async () => {
      await backend.cleanup();
    });

    it("reads an instance that has never been written as empty, not as an error", async () => {
      // A fresh instance and a broken store must not look the same. This is the
      // read every page does on first boot.
      expect(await store.readCameras(INSTANCE)).toEqual([]);
      expect(await store.readScenarios(INSTANCE)).toEqual([]);
      expect(await store.readPromptSets(INSTANCE)).toEqual([]);
      expect(await store.readStatus(INSTANCE)).toBeNull();
      expect(await store.readPrompt(INSTANCE)).toBeNull();
      expect(await store.readActivePromptId(INSTANCE)).toBeNull();
    });

    it("round-trips cameras, preserving id and rtspUrl", async () => {
      await store.writeCameras(INSTANCE, [cam("front"), cam("back")], "me@scality.com");
      const got = await store.readCameras(INSTANCE);
      expect(got.map((c) => c.id).sort()).toEqual(["back", "front"]);
      expect(got.find((c) => c.id === "front")?.rtspUrl).toBe("rtsp://cams:8554/front");
    });

    it("writeCameras replaces the whole list — a camera not in it is gone", async () => {
      await store.writeCameras(INSTANCE, [cam("a"), cam("b")], "me");
      await store.writeCameras(INSTANCE, [cam("b")], "me");
      expect((await store.readCameras(INSTANCE)).map((c) => c.id)).toEqual(["b"]);
    });

    it("upsertCamera adds, then replaces in place without duplicating", async () => {
      await store.upsertCamera(INSTANCE, cam("front", { description: "one" }), "me");
      await store.upsertCamera(INSTANCE, cam("front", { description: "two" }), "me");
      const got = await store.readCameras(INSTANCE);
      expect(got).toHaveLength(1);
      expect(got[0].description).toBe("two");
    });

    // ── The two that would have broken silently ──────────────────────────────

    it("upsertCamera REPLACES the entity: an omitted promptId is unbound, not kept", async () => {
      await store.upsertCamera(INSTANCE, cam("front", { promptId: "door-watch" }), "me");
      expect((await store.readCameras(INSTANCE))[0].promptId).toBe("door-watch");

      // Exactly what the camera PATCH route does to unbind: delete the key and
      // upsert the object. A field merge keeps "door-watch" and the camera stays
      // driven through the realtime API while the UI shows it unbound.
      const next = { ...(await store.readCameras(INSTANCE))[0] };
      delete next.promptId;
      await store.upsertCamera(INSTANCE, next, "me");

      expect((await store.readCameras(INSTANCE))[0].promptId).toBeUndefined();
    });

    it("upsertCamera keeps scenarioIds tri-state: absent, empty and populated stay distinct", async () => {
      // undefined = the scenario's own sensor_filter glob decides.
      // []        = explicit suppression, no override fires.
      // [ids]     = exactly these.
      await store.upsertCamera(INSTANCE, cam("front", { scenarioIds: ["loitering"] }), "me");
      expect((await store.readCameras(INSTANCE))[0].scenarioIds).toEqual(["loitering"]);

      await store.upsertCamera(INSTANCE, cam("front", { scenarioIds: [] }), "me");
      const suppressed = (await store.readCameras(INSTANCE))[0].scenarioIds;
      expect(suppressed).toEqual([]);
      expect(suppressed).not.toBeUndefined(); // [] must not read as absent

      const next = { ...(await store.readCameras(INSTANCE))[0] };
      delete next.scenarioIds;
      await store.upsertCamera(INSTANCE, next, "me");
      expect((await store.readCameras(INSTANCE))[0].scenarioIds).toBeUndefined();
    });

    // ── Independence of the entity kinds sharing one instance ────────────────

    it("deleteCamera removes only its own camera", async () => {
      await store.writeCameras(INSTANCE, [cam("a"), cam("b")], "me");
      await store.deleteCamera(INSTANCE, "a", "me");
      expect((await store.readCameras(INSTANCE)).map((c) => c.id)).toEqual(["b"]);
    });

    it("a status write leaves cameras, scenarios and prompt-sets alone", async () => {
      // The console pod owns the first three; the reconcile-agent pod writes
      // status on every tick. In the file store both are read-modify-writes of
      // one file, which is why this is a contract property and not an obvious one.
      await store.writeCameras(INSTANCE, [cam("a")], "me");
      await store.writeScenarios(INSTANCE, [scenario("s1")], "me");
      await store.upsertPromptSet(INSTANCE, promptSet("default"), "me");
      await store.setActivePromptId(INSTANCE, "default", "me");

      const status = emptyStatus("agent@test", "2026-08-12T10:00:00.000Z");
      status.drift = ["one note"];
      await store.writeStatus(INSTANCE, status);

      expect((await store.readCameras(INSTANCE)).map((c) => c.id)).toEqual(["a"]);
      expect((await store.readScenarios(INSTANCE)).map((s) => s.id)).toEqual(["s1"]);
      expect((await store.readPromptSets(INSTANCE)).map((s) => s.id)).toEqual(["default"]);
      expect(await store.readActivePromptId(INSTANCE)).toBe("default");
      expect((await store.readStatus(INSTANCE))?.drift).toEqual(["one note"]);
    });

    it("scenarios round-trip and replace wholesale", async () => {
      await store.writeScenarios(INSTANCE, [scenario("s1"), scenario("s2")], "me");
      expect((await store.readScenarios(INSTANCE)).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
      await store.writeScenarios(INSTANCE, [scenario("s2")], "me");
      expect((await store.readScenarios(INSTANCE)).map((s) => s.id)).toEqual(["s2"]);
    });

    it("keeps a scenario's severity and enabled flag through a round-trip", async () => {
      const s: ScenarioEntry = { ...scenario("s1"), severity: "critical", enabled: false };
      await store.writeScenarios(INSTANCE, [s], "me");
      const got = (await store.readScenarios(INSTANCE))[0];
      expect(got.severity).toBe("critical");
      expect(got.enabled).toBe(false);
    });

    // ── Prompt resolution: the active set wins over the legacy doc ───────────

    it("readPrompt prefers the active prompt-set over the legacy prompt", async () => {
      await store.writePrompt(INSTANCE, { prompt: "legacy text" }, "me");
      expect((await store.readPrompt(INSTANCE))?.prompt).toBe("legacy text");

      await store.upsertPromptSet(INSTANCE, promptSet("night", "night text"), "me");
      await store.setActivePromptId(INSTANCE, "night", "me");
      expect((await store.readPrompt(INSTANCE))?.prompt).toBe("night text");
    });

    it("falls back to the legacy prompt when the active id names no existing set", async () => {
      // A prompt-set can be deleted while it is active. Returning null there
      // would leave the VLM with no system prompt at all.
      await store.writePrompt(INSTANCE, { prompt: "legacy text" }, "me");
      await store.upsertPromptSet(INSTANCE, promptSet("night"), "me");
      await store.setActivePromptId(INSTANCE, "night", "me");
      await store.deletePromptSet(INSTANCE, "night", "me");
      expect((await store.readPrompt(INSTANCE))?.prompt).toBe("legacy text");
    });

    it("carries a prompt model when one is set, and omits it when not", async () => {
      await store.writePrompt(INSTANCE, { prompt: "p", model: "vila-1.5" }, "me");
      expect(await store.readPrompt(INSTANCE)).toEqual({ prompt: "p", model: "vila-1.5" });
      await store.writePrompt(INSTANCE, { prompt: "p2" }, "me");
      expect(await store.readPrompt(INSTANCE)).toEqual({ prompt: "p2" });
    });

    it("upsertPromptSet replaces in place; deletePromptSet removes only its own", async () => {
      await store.upsertPromptSet(INSTANCE, promptSet("a", "first"), "me");
      await store.upsertPromptSet(INSTANCE, promptSet("a", "second"), "me");
      await store.upsertPromptSet(INSTANCE, promptSet("b"), "me");
      expect(await store.readPromptSets(INSTANCE)).toHaveLength(2);
      expect((await store.readPromptSets(INSTANCE)).find((s) => s.id === "a")?.text).toBe("second");
      await store.deletePromptSet(INSTANCE, "a", "me");
      expect((await store.readPromptSets(INSTANCE)).map((s) => s.id)).toEqual(["b"]);
    });

    it("keeps two instances' data apart", async () => {
      await store.writeCameras(INSTANCE, [cam("a")], "me");
      await store.writeCameras("other-instance", [cam("z")], "me");
      expect((await store.readCameras(INSTANCE)).map((c) => c.id)).toEqual(["a"]);
      expect((await store.readCameras("other-instance")).map((c) => c.id)).toEqual(["z"]);
    });

    it("survives concurrent writes to different entity kinds", async () => {
      // The real pair: an operator's camera upsert against the agent's status
      // write. Serialised by the file store's lock; independent documents in
      // Firestore. Either way, neither may lose the other.
      await Promise.all([
        store.upsertCamera(INSTANCE, cam("front"), "operator"),
        store.writeStatus(INSTANCE, emptyStatus("agent@test", "2026-08-12T10:00:00.000Z")),
        store.upsertPromptSet(INSTANCE, promptSet("default"), "operator"),
      ]);
      expect((await store.readCameras(INSTANCE)).map((c) => c.id)).toEqual(["front"]);
      expect(await store.readStatus(INSTANCE)).not.toBeNull();
      expect((await store.readPromptSets(INSTANCE)).map((s) => s.id)).toEqual(["default"]);
    });

    it("does not lose a camera when many upserts race", async () => {
      const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
      await Promise.all(ids.map((id) => store.upsertCamera(INSTANCE, cam(id), "operator")));
      expect((await store.readCameras(INSTANCE)).map((c) => c.id).sort()).toEqual([...ids].sort());
    });
  });
}

// ─── File-store specifics: the failure modes a database does not have ─────────

describe("FileConfigStore — file-level behaviour", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cfgfile-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one file per instance, named for it", async () => {
    const store = new FileConfigStore(dir);
    await store.writeCameras("inst-a", [cam("x")], "me");
    await store.writeCameras("inst-b", [cam("y")], "me");
    const a = await readFile(configFilePath("inst-a", dir), "utf8");
    expect(a).toContain("instance: inst-a");
    expect(a).toContain("id: x");
    expect(a).not.toContain("id: y");
  });

  it("stores readable YAML an operator can diff", async () => {
    const store = new FileConfigStore(dir);
    await store.writeCameras("inst-a", [cam("front", { description: "lobby" })], "me@scality.com");
    const body = await readFile(configFilePath("inst-a", dir), "utf8");
    expect(body).toContain("schema: isv-labs.console-config.v1");
    expect(body).toContain("description: lobby");
    expect(body).toContain("updatedBy: me@scality.com");
  });

  it("refuses an instance name that would escape the data directory", async () => {
    const store = new FileConfigStore(dir);
    for (const bad of ["../etc/passwd", "a/b", "..", "", ".hidden", "x".repeat(200)]) {
      await expect(store.readCameras(bad)).rejects.toThrow(ConfigFileError);
    }
  });

  it("fails loudly on a corrupt file instead of reading it as an empty instance", async () => {
    // The whole reason this is not a silent fallback: the reconciler converges
    // the cluster onto what it reads, so "empty" would tear down every camera.
    const store = new FileConfigStore(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(configFilePath("inst-a", dir), "cameras: [oops\n  - broken: yaml:");
    await expect(store.readCameras("inst-a")).rejects.toThrow(/not valid YAML/);
  });

  it("rejects a file whose shape is wrong, naming the field", async () => {
    const store = new FileConfigStore(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(configFilePath("inst-a", dir), "cameras: not-a-list\n");
    await expect(store.readCameras("inst-a")).rejects.toThrow(/"cameras" must be a list/);
  });

  it("rejects an entity with no id rather than dropping it", async () => {
    const store = new FileConfigStore(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(configFilePath("inst-a", dir), "cameras:\n  - rtspUrl: rtsp://x/1\n");
    await expect(store.readCameras("inst-a")).rejects.toThrow(/cameras\[0\] has no string "id"/);
  });

  it("rejects a file written by some other tool", async () => {
    const store = new FileConfigStore(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(configFilePath("inst-a", dir), "schema: something.else.v9\ncameras: []\n");
    await expect(store.readCameras("inst-a")).rejects.toThrow(/unknown schema/);
  });

  it("keeps unknown fields on an entity through a read", async () => {
    // Forward compatibility: a newer console stores a field this one has never
    // heard of. Rejecting it would make an older pod unable to read the store at
    // all; dropping it would erase the field on the next write-back.
    const store = new FileConfigStore(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      configFilePath("inst-a", dir),
      "schema: isv-labs.console-config.v1\ninstance: inst-a\ncameras:\n  - id: x\n    somethingNew: 42\n",
    );
    const got = (await store.readCameras("inst-a")) as unknown as Record<string, unknown>[];
    expect(got[0].somethingNew).toBe(42);
  });

  it("leaves no lock or temp file behind after a write", async () => {
    const store = new FileConfigStore(dir);
    await store.writeCameras("inst-a", [cam("x")], "me");
    const { readdir } = await import("fs/promises");
    const entries = await readdir(dir);
    expect(entries).toEqual(["inst-a.yaml"]);
  });

  it("releases the lock when the write throws", async () => {
    // A held lock would wedge every later write in the pod, so the failure has to
    // clean up after itself.
    const store = new FileConfigStore(dir);
    await expect(store.readCameras("bad/name")).rejects.toThrow();
    await store.writeCameras("inst-a", [cam("x")], "me");
    expect((await store.readCameras("inst-a")).map((c) => c.id)).toEqual(["x"]);
  });
});
