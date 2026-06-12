import type { ConfigStore, ReconcileStatus } from "@/lib/config-store/types";
import { emptyStatus } from "@/lib/config-store/types";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import { reconcileCameras } from "@/lib/reconcile/cameras";

export interface ReconcileRunOptions {
  prune: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  /** Agent build id stamped into the status. */
  agentVersion?: string;
}

/**
 * One reconcile pass for an instance's cameras: read desired from the store,
 * converge the cluster via the adapter, persist a status doc.
 *
 * Reconcile failures (store read, adapter calls, per-camera errors) are caught
 * and recorded in `status.errors` — those never throw. The final
 * `store.writeStatus` is intentionally NOT guarded and DOES propagate: a
 * persistence failure cannot be recorded in the status it failed to write, so
 * swallowing it would falsely signal success. Callers running this in a loop
 * (the reconcile agent) should wrap each pass to tolerate writeback errors.
 */
export async function reconcileInstanceCameras(
  store: ConfigStore,
  adapter: ClusterAdapter,
  instance: string,
  opts: ReconcileRunOptions,
): Promise<ReconcileStatus> {
  const now = opts.now ?? (() => new Date().toISOString());
  const status = emptyStatus(opts.agentVersion ?? "dev", now());

  try {
    const desired = await store.readCameras(instance);
    const result = await reconcileCameras(desired, adapter, { prune: opts.prune });
    status.applied.camerasAdded = result.added.length;
    status.applied.camerasPruned = result.pruned.length;
    status.drift = result.drift;
    status.errors = result.failed.map((f) => `camera ${f.id}: ${f.warning ?? "unknown error"}`);
  } catch (err) {
    status.errors.push(err instanceof Error ? err.message : String(err));
  }

  await store.writeStatus(instance, status);
  return status;
}
