import type { CameraEntry } from "@/lib/helpers/gcs-config";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";

export interface CameraReconcileResult {
  /** Camera ids newly added to the cluster this run. */
  added: string[];
  /** Camera ids already present (live sensor name matched). */
  alreadyPresent: string[];
  /** Camera ids that failed to add, with the adapter's warning. */
  failed: { id: string; warning?: string }[];
  /** Camera ids (live sensor names) removed this run (prune only). */
  pruned: string[];
  /** Human-readable desired-vs-live differences observed. */
  drift: string[];
}

/**
 * Converge the live VIOS sensor set toward `desired`.
 *
 * Identity: a live sensor is "the same camera" as a desired entry when the
 * sensor's `name` equals the desired `id` (we always register with
 * name == camera id; VIOS assigns its own UUID sensorId).
 *
 * Additive by default: adds missing cameras, never removes. `prune:true` plus
 * an adapter that implements `removeSensor` removes live sensors absent from
 * `desired`. Never throws — failures are reported in the result.
 */
export async function reconcileCameras(
  desired: CameraEntry[],
  adapter: ClusterAdapter,
  opts: { prune: boolean },
): Promise<CameraReconcileResult> {
  const result: CameraReconcileResult = {
    added: [],
    alreadyPresent: [],
    failed: [],
    pruned: [],
    drift: [],
  };

  const live = await adapter.listSensors();
  const liveByName = new Map(live.map((s) => [s.name, s]));
  const desiredIds = new Set(desired.map((c) => c.id));

  // Add / confirm desired cameras.
  for (const cam of desired) {
    if (liveByName.has(cam.id)) {
      result.alreadyPresent.push(cam.id);
      continue;
    }
    const res = await adapter.addSensor(cam.id, cam.rtspUrl, cam.description);
    if (res.ok) result.added.push(cam.id);
    else result.failed.push({ id: cam.id, warning: res.warning });
  }

  // Handle extras (live sensors not in desired).
  for (const s of live) {
    if (desiredIds.has(s.name)) continue;
    result.drift.push(`extra live sensor not in desired: ${s.name}`);
    if (opts.prune && adapter.removeSensor) {
      const res = await adapter.removeSensor(s.sensorId);
      if (res.ok) result.pruned.push(s.name);
      else result.failed.push({ id: s.name, warning: res.warning });
    }
  }

  return result;
}
