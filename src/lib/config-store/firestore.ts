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
 * The GCP project holding the config store, or undefined when nobody has said.
 *
 * There is deliberately no default. One was hardcoded in three places, naming a
 * single organisation's project, so an outside build with no configuration went
 * looking for its cameras, prompt and scenarios in an account it has no access
 * to, and failed with a permission error rather than with "unconfigured". The
 * two are opposite problems and only one of them is the reader's to fix.
 *
 * The Scality labs supply it from the deployment, in
 * `isv-labs:scripts/deploy-console.sh`, alongside the Sentry DSN.
 */
export function firestoreProjectId(): string | undefined {
  const id = (process.env.FIRESTORE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT)?.trim();
  return id ? id : undefined;
}

export function firestoreDatabaseId(): string {
  return process.env.FIRESTORE_DATABASE_ID ?? "(default)";
}

/**
 * Production factory. Lazy-imports the SDK (keeps it out of the unit tests and
 * client bundle). Credentials come from GOOGLE_APPLICATION_CREDENTIALS / ADC.
 *
 * Throws when no project is configured, rather than letting the SDK resolve one
 * from ambient credentials: on a developer laptop that silently reaches whatever
 * project `gcloud` last logged into, which is how a write lands somewhere nobody
 * chose. The message names the variable to set.
 */
export async function makeFirestoreConfigStore(): Promise<FirestoreConfigStore> {
  const projectId = firestoreProjectId();
  if (!projectId) {
    throw new Error(
      "config store is unconfigured: set FIRESTORE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) " +
        "to the GCP project holding it",
    );
  }
  const { Firestore } = await import("@google-cloud/firestore");
  const db: Firestore = new Firestore({
    projectId,
    databaseId: firestoreDatabaseId(),
  });
  return new FirestoreConfigStore(db as unknown as FirestoreLike);
}

export interface FirestoreHealthResult {
  // `unconfigured` is its own state on purpose: nobody has named a project, which
  // is a setting to supply rather than a fault to debug. Reporting it as `error`
  // sent the reader looking for a broken store, and reporting it as
  // `no-credentials` named the wrong variable.
  status: "ok" | "unconfigured" | "no-credentials" | "error";
  detail?: string;
  project: string;
  database: string;
  counts?: { promptSets: number; cameras: number; scenarios: number };
}

/** Connectivity + content probe for the Firestore config store, mirroring
 *  gcsHealthCheck. Reads the instance's prompt-sets / cameras / scenarios to
 *  confirm reachability and surface per-collection counts. Never throws.
 *  `storeFactory` is injectable for deterministic tests. */
export async function firestoreHealthCheck(
  instance: string,
  storeFactory: () => Promise<
    Pick<ConfigStore, "readPromptSets" | "readCameras" | "readScenarios">
  > = makeFirestoreConfigStore,
): Promise<FirestoreHealthResult> {
  const project = firestoreProjectId() ?? "";
  const database = firestoreDatabaseId();
  if (!project) {
    return {
      status: "unconfigured",
      detail: "FIRESTORE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) not set",
      project,
      database,
    };
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return { status: "no-credentials", detail: "GOOGLE_APPLICATION_CREDENTIALS not set", project, database };
  }
  if (!instance) {
    return { status: "error", detail: "VSS_INSTANCE_NAME not set", project, database };
  }
  try {
    const store = await storeFactory();
    const [promptSets, cameras, scenarios] = await Promise.all([
      store.readPromptSets(instance),
      store.readCameras(instance),
      store.readScenarios(instance),
    ]);
    return {
      status: "ok",
      project,
      database,
      counts: { promptSets: promptSets.length, cameras: cameras.length, scenarios: scenarios.length },
    };
  } catch (err) {
    return {
      status: "error",
      detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      project,
      database,
    };
  }
}
