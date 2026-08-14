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
  /**
   * Disabled cameras (recording.enabled === false) that were de-registered
   * from the live sensor set this run because they were still registered.
   * The camera config is preserved in `desired`; re-enabling recording
   * re-adds it on the next reconcile.
   */
  parked: string[];
  /** Human-readable desired-vs-live differences observed. */
  drift: string[];
}

/** A camera is "parked" (must not be a live sensor) when its recording is
 *  explicitly disabled. VIOS/streamprocessing otherwise retries "add live
 *  stream" against the (often stale) RTSP URL of a registered-but-unconnectable
 *  sensor forever, flooding the vision-llm-errors topic. */
function isParked(cam: CameraEntry): boolean {
  return cam.recording?.enabled === false;
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
    parked: [],
    drift: [],
  };

  const live = await adapter.listSensors();
  const liveByName = new Map(live.map((s) => [s.name, s]));
  const desiredIds = new Set(desired.map((c) => c.id));

  // Add / confirm desired cameras. Disabled cameras are "parked": never added,
  // and de-registered if currently live (independent of `prune`, which only
  // governs sensors absent from `desired`).
  for (const cam of desired) {
    const liveSensor = liveByName.get(cam.id);

    if (isParked(cam)) {
      if (liveSensor && adapter.removeSensor) {
        const res = await adapter.removeSensor(liveSensor.uuid ?? liveSensor.sensorId);
        if (res.ok) {
          result.parked.push(cam.id);
          result.drift.push(`parked disabled camera (de-registered live sensor): ${cam.id}`);
        } else {
          result.failed.push({ id: cam.id, warning: res.warning });
        }
      }
      continue;
    }

    if (liveSensor) {
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
    // A `removed` sensor is VST's tombstone for one already deleted, not a sensor.
    // VST keeps them in /sensor/list forever, so without this every camera ever
    // deleted is reported as an extra live sensor on every pass — and the report is
    // the thing this drift list exists to make readable. Measured on
    // pyramid-showroom 2026-08-14: 21 entries in /sensor/list, 5 online cameras
    // matching the store, 15 tombstones and 1 offline stub, producing the same 16
    // drift notes every 60s for over a week. A signal that is never empty cannot
    // show you a real difference, which is the only reason anyone reads it.
    //
    // It also stops prune acting on them: with `opts.prune` on, the branch below
    // would call removeSensor once per tombstone, per pass, forever.
    if (s.status === "removed") continue;
    result.drift.push(`extra live sensor not in desired: ${s.name}`);
    if (opts.prune && adapter.removeSensor) {
      const res = await adapter.removeSensor(s.uuid ?? s.sensorId);
      if (res.ok) result.pruned.push(s.name);
      else result.failed.push({ id: s.name, warning: res.warning });
    }
  }

  return result;
}
