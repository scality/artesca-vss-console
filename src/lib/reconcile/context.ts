import "server-only";
import { makeFirestoreConfigStore } from "@/lib/config-store/firestore";
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
 *  when the instance is unknown or Firestore cannot be initialised — callers
 *  catch and degrade (GET) or surface a warning (write). */
export async function makeReconcileContext(): Promise<ReconcileContext> {
  const instance = process.env.VSS_INSTANCE_NAME ?? "";
  if (!instance) throw new ReconcileContextError("VSS_INSTANCE_NAME unset");
  const { CLUSTER } = await import("@/lib/cluster-refs");
  let store: ConfigStore;
  try {
    store = await makeFirestoreConfigStore();
  } catch (err) {
    throw new ReconcileContextError(
      `Firestore init failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { store, adapter: new VstClusterAdapter(), refs: buildReconcileRefs(CLUSTER), instance };
}
