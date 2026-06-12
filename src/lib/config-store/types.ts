import type { CameraEntry } from "@/lib/helpers/gcs-config";

export type { CameraEntry };

/** Convergence status the reconciler writes back after each run. */
export interface ReconcileStatus {
  /** ISO timestamp of the last reconcile run. */
  lastRunAt: string;
  /** Counts applied on the last run. */
  applied: { camerasAdded: number; camerasPruned: number };
  /** Human-readable drift notes (desired-vs-live differences observed). */
  drift: string[];
  /** Human-readable errors from the last run (empty = clean). */
  errors: string[];
  /** Agent build identifier, for debugging which agent applied the state. */
  agentVersion: string;
}

/** A zero-valued status stamped at `now`. */
export function emptyStatus(agentVersion: string, now: string): ReconcileStatus {
  return {
    lastRunAt: now,
    applied: { camerasAdded: 0, camerasPruned: 0 },
    drift: [],
    errors: [],
    agentVersion,
  };
}

/**
 * Store-agnostic config persistence. Plan 1 covers cameras + status; prompt and
 * scenarios methods are added in Plan 4. The reconciler and the deployer both
 * depend on this interface, never on a concrete store.
 */
export interface ConfigStore {
  readCameras(instance: string): Promise<CameraEntry[]>;
  /**
   * Overwrite the camera list for `instance`. `updatedBy` is stamped into the
   * store for the audit trail (e.g. an operator email, or "reconciler@<version>").
   */
  writeCameras(instance: string, cameras: CameraEntry[], updatedBy: string): Promise<void>;
  readStatus(instance: string): Promise<ReconcileStatus | null>;
  writeStatus(instance: string, status: ReconcileStatus): Promise<void>;
}
