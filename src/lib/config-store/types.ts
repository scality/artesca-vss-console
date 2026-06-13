import type { CameraEntry } from "@/lib/helpers/gcs-config";

export type { CameraEntry };

/** VLM system prompt stored in the config store. */
export interface PromptDoc {
  prompt: string;
  model?: string;
}

/** A named, reusable VLM system prompt ("use case"). */
export interface PromptSet { id: string; name: string; text: string; model?: string; alertType?: string }

/** A single alert-scenario entry stored in the config store. */
export interface ScenarioEntry {
  id: string;
  name: string;
  description?: string;
  severity: "low" | "medium" | "high" | "critical";
  channels: ("ui" | "slack")[];
  sensor_filter: string;
  keywords: string[];
  enabled: boolean;
  cooldown_seconds?: number;
}

/** Convergence status the reconciler writes back after each run. */
export interface ReconcileStatus {
  /** ISO timestamp of the last reconcile run. */
  lastRunAt: string;
  /** Counts applied on the last run. */
  applied: {
    camerasAdded: number;
    camerasPruned: number;
    promptUpdated: boolean;
    scenariosUpdated: boolean;
  };
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
    applied: { camerasAdded: 0, camerasPruned: 0, promptUpdated: false, scenariosUpdated: false },
    drift: [],
    errors: [],
    agentVersion,
  };
}

/**
 * Store-agnostic config persistence. Covers cameras, status, prompt, and
 * scenarios. The reconciler and the deployer both depend on this interface,
 * never on a concrete store.
 */
export interface ConfigStore {
  readCameras(instance: string): Promise<CameraEntry[]>;
  /**
   * Overwrite the camera list for `instance`. `updatedBy` is stamped into the
   * store for the audit trail (e.g. an operator email, or "reconciler@<version>").
   */
  writeCameras(instance: string, cameras: CameraEntry[], updatedBy: string): Promise<void>;
  /** Add or replace a single camera (atomic single-doc write). */
  upsertCamera(instance: string, camera: CameraEntry, updatedBy: string): Promise<void>;
  /** Remove a single camera by id (atomic single-doc delete). */
  deleteCamera(instance: string, id: string, updatedBy: string): Promise<void>;
  readStatus(instance: string): Promise<ReconcileStatus | null>;
  writeStatus(instance: string, status: ReconcileStatus): Promise<void>;
  /**
   * Resolves the active prompt-set's `{prompt, model}` when set; else the legacy single prompt doc.
   */
  readPrompt(instance: string): Promise<PromptDoc | null>;
  writePrompt(instance: string, prompt: PromptDoc, updatedBy: string): Promise<void>;
  readScenarios(instance: string): Promise<ScenarioEntry[]>;
  writeScenarios(instance: string, scenarios: ScenarioEntry[], updatedBy: string): Promise<void>;
  readPromptSets(instance: string): Promise<PromptSet[]>;
  upsertPromptSet(instance: string, set: PromptSet, updatedBy: string): Promise<void>;
  deletePromptSet(instance: string, id: string, updatedBy: string): Promise<void>;
  readActivePromptId(instance: string): Promise<string | null>;
  setActivePromptId(instance: string, id: string, updatedBy: string): Promise<void>;
}
