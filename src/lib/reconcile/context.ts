import "server-only";
import { makeConfigStore, configStoreKind } from "@/lib/config-store";
import { VstClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import { buildReconcileRefs } from "@/lib/reconcile/refs";
import type { ConfigStore } from "@/lib/config-store/types";
import type { ReconcileRunOptions } from "@/lib/reconcile/run";

export class ReconcileContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileContextError";
  }
}

export interface ReconcileContext {
  store: ConfigStore;
  adapter: VstClusterAdapter;
  refs: NonNullable<ReconcileRunOptions["refs"]>;
  instance: string;
}

/** Build the k8s reconcile context for a route. Throws ReconcileContextError
 *  when the instance is unknown or the config store cannot be initialised —
 *  callers catch and degrade (GET) or surface a warning (write). */
export async function makeReconcileContext(): Promise<ReconcileContext> {
  const instance = process.env.VSS_INSTANCE_NAME ?? "";
  if (!instance) throw new ReconcileContextError("VSS_INSTANCE_NAME unset");
  const { CLUSTER } = await import("@/lib/cluster-refs");
  let store: ConfigStore;
  try {
    store = await makeConfigStore();
  } catch (err) {
    // Name the backend in the message. The two failures read identically
    // otherwise ("init failed"), and they have opposite fixes: a file store
    // failing means the data directory is unwritable — usually the PVC is not
    // mounted — while Firestore failing means a project, credential or the
    // optional SDK is missing.
    throw new ReconcileContextError(
      `config store (${configStoreKind()}) init failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return { store, adapter: new VstClusterAdapter(), refs: buildReconcileRefs(CLUSTER), instance };
}
