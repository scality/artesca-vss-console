import "server-only";

import type { Firestore } from "@google-cloud/firestore";
import type {
  ConfigStore,
  CameraEntry,
  ReconcileStatus,
  PromptDoc,
  PromptSet,
  ScenarioEntry,
} from "@/lib/config-store/types";

/**
 * The narrow slice of the Firestore API this store uses. Declaring it as a port
 * keeps the SDK at one seam and lets unit tests inject an in-memory fake (no
 * emulator needed). The real `Firestore` instance structurally satisfies it.
 */
export interface FirestoreLike {
  collection(path: string): {
    get(): Promise<{ docs: { id: string; data(): Record<string, unknown> }[] }>;
    doc(id: string): {
      set(data: Record<string, unknown>): Promise<unknown>;
      delete(): Promise<unknown>;
    };
  };
  doc(path: string): {
    get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
    set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<unknown>;
  };
}

const camerasPath = (instance: string) => `instances/${instance}/cameras`;
const instanceDocPath = (instance: string) => `instances/${instance}`;
const scenariosPath = (instance: string) => `instances/${instance}/scenarios`;
const promptsPath = (instance: string) => `instances/${instance}/prompts`;

/**
 * Firestore-backed ConfigStore. Data model:
 *    instances/<instance>            (doc; holds { reconcileStatus })
 *      └─ cameras/<cameraId>         (subcollection docs; CameraEntry minus id)
 */
export class FirestoreConfigStore implements ConfigStore {
  constructor(private readonly db: FirestoreLike) {}

  async readCameras(instance: string): Promise<CameraEntry[]> {
    const snap = await this.db.collection(camerasPath(instance)).get();
    return snap.docs.map((d) => {
      const data = d.data() as Omit<CameraEntry, "id">;
      return { ...data, id: d.id } as CameraEntry;
    });
  }

  async writeCameras(instance: string, cameras: CameraEntry[], updatedBy: string): Promise<void> {
    const col = this.db.collection(camerasPath(instance));
    const desiredIds = new Set(cameras.map((c) => c.id));

    // Non-atomic: read-delete-upsert is three round-trips, so concurrent writers
    // can produce partial state. Acceptable today (the reconciler is the sole
    // writer); revisit with a Firestore transaction if the console also writes.
    const existing = await col.get();
    for (const d of existing.docs) {
      if (!desiredIds.has(d.id)) await col.doc(d.id).delete();
    }

    // Upsert desired. Store every field except `id` (id is the doc key).
    const updatedAt = new Date().toISOString();
    for (const cam of cameras) {
      const { id, ...rest } = cam;
      await col.doc(id).set({ ...rest, updatedBy, updatedAt });
    }
  }

  async upsertCamera(instance: string, camera: CameraEntry, updatedBy: string): Promise<void> {
    const { id, ...rest } = camera;
    await this.db
      .collection(camerasPath(instance))
      .doc(id)
      .set({ ...rest, updatedBy, updatedAt: new Date().toISOString() });
  }

  async deleteCamera(instance: string, id: string, _updatedBy: string): Promise<void> {
    await this.db.collection(camerasPath(instance)).doc(id).delete();
  }

  async readStatus(instance: string): Promise<ReconcileStatus | null> {
    const snap = await this.db.doc(instanceDocPath(instance)).get();
    if (!snap.exists) return null;
    const status = (snap.data() ?? {}).reconcileStatus as ReconcileStatus | undefined;
    return status ?? null;
  }

  async writeStatus(instance: string, status: ReconcileStatus): Promise<void> {
    await this.db.doc(instanceDocPath(instance)).set({ reconcileStatus: status }, { merge: true });
  }

  async readPrompt(instance: string): Promise<PromptDoc | null> {
    const activeId = await this.readActivePromptId(instance);
    if (activeId) {
      const active = (await this.readPromptSets(instance)).find((s) => s.id === activeId);
      if (active) return { prompt: active.text, ...(active.model ? { model: active.model } : {}) };
    }
    // legacy fallback:
    const snap = await this.db.doc(instanceDocPath(instance)).get();
    if (!snap.exists) return null;
    const raw = (snap.data() ?? {}).prompt as Record<string, unknown> | undefined;
    if (!raw || typeof raw.prompt !== "string") return null;
    const doc: PromptDoc = { prompt: raw.prompt };
    if (typeof raw.model === "string") doc.model = raw.model;
    return doc;
  }

  async readPromptSets(instance: string): Promise<PromptSet[]> {
    const snap = await this.db.collection(promptsPath(instance)).get();
    return snap.docs.map((d) => ({ ...(d.data() as Omit<PromptSet, "id">), id: d.id }));
  }

  async upsertPromptSet(instance: string, set: PromptSet, updatedBy: string): Promise<void> {
    const { id, ...rest } = set;
    await this.db.collection(promptsPath(instance)).doc(id).set({ ...rest, updatedBy, updatedAt: new Date().toISOString() });
  }

  async deletePromptSet(instance: string, id: string, _updatedBy: string): Promise<void> {
    await this.db.collection(promptsPath(instance)).doc(id).delete();
  }

  async readActivePromptId(instance: string): Promise<string | null> {
    const snap = await this.db.doc(instanceDocPath(instance)).get();
    const v = (snap.data() ?? {}).activePromptId;
    return typeof v === "string" ? v : null;
  }

  async setActivePromptId(instance: string, id: string, _updatedBy: string): Promise<void> {
    await this.db.doc(instanceDocPath(instance)).set({ activePromptId: id }, { merge: true });
  }

  async writePrompt(instance: string, prompt: PromptDoc, updatedBy: string): Promise<void> {
    await this.db.doc(instanceDocPath(instance)).set(
      {
        prompt: {
          prompt: prompt.prompt,
          ...(prompt.model ? { model: prompt.model } : {}),
          updatedBy,
          updatedAt: new Date().toISOString(),
        },
      },
      { merge: true },
    );
  }

  async readScenarios(instance: string): Promise<ScenarioEntry[]> {
    const snap = await this.db.collection(scenariosPath(instance)).get();
    return snap.docs.map((d) => {
      const data = d.data() as Omit<ScenarioEntry, "id">;
      return { ...data, id: d.id } as ScenarioEntry;
    });
  }

  async writeScenarios(
    instance: string,
    scenarios: ScenarioEntry[],
    updatedBy: string,
  ): Promise<void> {
    const col = this.db.collection(scenariosPath(instance));
    const desiredIds = new Set(scenarios.map((s) => s.id));

    // Non-atomic replace: read-delete-upsert (same semantics as writeCameras).
    const existing = await col.get();
    for (const d of existing.docs) {
      if (!desiredIds.has(d.id)) await col.doc(d.id).delete();
    }

    const updatedAt = new Date().toISOString();
    for (const scenario of scenarios) {
      const { id, ...rest } = scenario;
      await col.doc(id).set({ ...rest, updatedBy, updatedAt });
    }
  }
}

/**
 * Production factory. Lazy-imports the SDK (keeps it out of the unit tests and
 * client bundle). Reads project from FIRESTORE_PROJECT_ID / GOOGLE_CLOUD_PROJECT
 * (default isv-alliances) and database from FIRESTORE_DATABASE_ID (default
 * "(default)"). Credentials come from GOOGLE_APPLICATION_CREDENTIALS / ADC.
 */
export async function makeFirestoreConfigStore(): Promise<FirestoreConfigStore> {
  const { Firestore } = await import("@google-cloud/firestore");
  const db: Firestore = new Firestore({
    projectId:
      process.env.FIRESTORE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "isv-alliances",
    databaseId: process.env.FIRESTORE_DATABASE_ID ?? "(default)",
  });
  return new FirestoreConfigStore(db as unknown as FirestoreLike);
}
