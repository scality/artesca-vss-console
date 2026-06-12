import "server-only";

import type { Firestore } from "@google-cloud/firestore";
import type { ConfigStore, CameraEntry, ReconcileStatus } from "@/lib/config-store/types";

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

  async readStatus(instance: string): Promise<ReconcileStatus | null> {
    const snap = await this.db.doc(instanceDocPath(instance)).get();
    if (!snap.exists) return null;
    const status = (snap.data() ?? {}).reconcileStatus as ReconcileStatus | undefined;
    return status ?? null;
  }

  async writeStatus(instance: string, status: ReconcileStatus): Promise<void> {
    await this.db.doc(instanceDocPath(instance)).set({ reconcileStatus: status }, { merge: true });
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
