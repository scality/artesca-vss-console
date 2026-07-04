import "server-only";
import type { VstSensor } from "@/lib/helpers/vst";
import type { CameraEntry } from "@/lib/config-store/types";
import type { RecordingStatus } from "@/lib/helpers/recording-health";

// Guarded auto-heal for the VST cloud recorder's known stall failure mode:
// recorder sessions stay alive but stop receiving frames while the source /
// VLM pipeline is fine (root-caused 2026-07-04 — see
// docs/superpowers/specs/2026-07-04-vss-recording-recovery-design.md). We
// can't patch the closed VST images, so we self-heal externally via the same
// delete-by-UUID + re-add pattern the camera Restart action already uses.
// Recording-only: a re-arm re-adds the sensor with the SAME rtspUrl, so VLM
// alert rules (keyed by sensor name) keep working.

export interface RecoveryConfig {
  /** How long a sensor must read "not-recording" before it's eligible for a re-arm. */
  stallThresholdMs: number;
  /** Minimum time between re-arm attempts on the same sensor. */
  rearmCooldownMs: number;
  /** Stop re-arming (mark degraded) once this many attempts have been made. */
  rearmMaxAttempts: number;
  /** Cap on re-arms fired within a single reconcile pass. */
  rearmMaxPerCycle: number;
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  stallThresholdMs: 300_000,
  rearmCooldownMs: 600_000,
  rearmMaxAttempts: 3,
  rearmMaxPerCycle: 1,
};

export type RecoveryOutcome =
  | "healthy"
  | "unknown"
  | "waiting"
  | "rearmed"
  | "rearm-failed"
  | "no-rtsp-url"
  | "degraded";

export interface SensorRecoveryOutcome {
  name: string;
  probe: RecordingStatus;
  outcome: RecoveryOutcome;
  /** Total re-arm attempts made on this sensor so far (across cycles). */
  attempts: number;
  warnings?: string[];
}

export interface RecoverySummary {
  outcomes: SensorRecoveryOutcome[];
  /** Sensor names re-armed this cycle. */
  reArmed: string[];
  /** Sensor names that newly (or still) read degraded this cycle. */
  degraded: string[];
}

interface RecoveryState {
  /** Epoch ms of the first consecutive "not-recording" probe. */
  notRecordingSince: number;
  /** Epoch ms of the last re-arm attempt, if any. */
  lastRearmAt?: number;
  /** Re-arm attempts made on this sensor so far. */
  attempts: number;
  /** Set once attempts reaches the configured max and the sensor is still down. */
  degraded: boolean;
}

/**
 * Module-level in-memory recovery state, keyed by sensor/camera name (we
 * always register VST sensors with name == camera id, so the two are the
 * same key space). A pod restart resets the stall timer — benign, matches
 * the `probeRecording` cache's own reset-on-restart behavior.
 */
const state = new Map<string, RecoveryState>();

export interface RecoverStalledRecordingDeps {
  /** Live VST sensors this cycle (any status — only ONLINE ones are acted on). */
  sensors: VstSensor[];
  /** Desired camera definitions, for rtspUrl resolution on re-arm. */
  desired: CameraEntry[];
  /** Ground-truth recording probe (injected for testability). */
  probe: (streamId: string) => Promise<RecordingStatus>;
  /** Re-arm action (injected for testability). */
  rearm: (name: string, rtspUrl: string, streamId: string) => Promise<{ ok: boolean; warnings: string[] }>;
  /** Clock (injected for testability). Returns epoch millis. */
  now?: () => number;
  log?: { warn: (msg: string, meta?: unknown) => void };
  config?: Partial<RecoveryConfig>;
}

function streamIdOf(s: VstSensor): string {
  const sid = (s as { streamId?: unknown }).streamId;
  return typeof sid === "string" ? sid : String(sid ?? "");
}

/**
 * Guarded auto-heal pass for stalled VST recordings. For every ONLINE sensor,
 * probes ground-truth recording status; a sensor stuck `not-recording` past
 * `stallThresholdMs` gets re-armed (delete + re-add with the same rtspUrl),
 * subject to a per-sensor cooldown and attempt cap, and an overall per-cycle
 * re-arm batch cap. `unknown` probes are never acted on. Never throws —
 * probe/rearm failures are captured per-sensor in the returned summary.
 */
export async function recoverStalledRecording(
  deps: RecoverStalledRecordingDeps,
): Promise<RecoverySummary> {
  const now = deps.now ?? (() => Date.now());
  const cfg: RecoveryConfig = { ...DEFAULT_RECOVERY_CONFIG, ...deps.config };
  const desiredByName = new Map(deps.desired.map((c) => [c.id, c.rtspUrl]));
  const online = deps.sensors.filter((s) => s.status === "online" && s.name);

  const outcomes: SensorRecoveryOutcome[] = [];
  const reArmed: string[] = [];
  const degraded: string[] = [];
  let rearmsThisCycle = 0;

  for (const sensor of online) {
    const name = sensor.name as string;
    const streamId = streamIdOf(sensor);

    let status: RecordingStatus;
    try {
      status = await deps.probe(streamId);
    } catch (err) {
      status = "unknown";
      deps.log?.warn(`recording-recovery: probe threw for ${name}`, { err });
    }

    if (status === "recording") {
      state.delete(name);
      outcomes.push({ name, probe: status, outcome: "healthy", attempts: 0 });
      continue;
    }

    if (status === "unknown") {
      const st = state.get(name);
      outcomes.push({ name, probe: status, outcome: "unknown", attempts: st?.attempts ?? 0 });
      continue;
    }

    // status === "not-recording"
    const nowMs = now();
    let st = state.get(name);
    if (!st) {
      st = { notRecordingSince: nowMs, attempts: 0, degraded: false };
      state.set(name, st);
    }

    if (st.attempts >= cfg.rearmMaxAttempts) {
      st.degraded = true;
      degraded.push(name);
      outcomes.push({ name, probe: status, outcome: "degraded", attempts: st.attempts });
      continue;
    }

    const stalledForMs = nowMs - st.notRecordingSince;
    const cooldownElapsed = st.lastRearmAt === undefined || nowMs - st.lastRearmAt > cfg.rearmCooldownMs;
    const pastThreshold = stalledForMs > cfg.stallThresholdMs;
    const batchAvailable = rearmsThisCycle < cfg.rearmMaxPerCycle;

    if (!pastThreshold || !cooldownElapsed || !batchAvailable) {
      outcomes.push({ name, probe: status, outcome: "waiting", attempts: st.attempts });
      continue;
    }

    const rtspUrl = desiredByName.get(name);
    if (!rtspUrl) {
      outcomes.push({ name, probe: status, outcome: "no-rtsp-url", attempts: st.attempts });
      continue;
    }

    rearmsThisCycle += 1;
    st.lastRearmAt = nowMs;
    st.attempts += 1;
    try {
      const res = await deps.rearm(name, rtspUrl, streamId);
      if (res.ok) {
        reArmed.push(name);
        outcomes.push({
          name,
          probe: status,
          outcome: "rearmed",
          attempts: st.attempts,
          warnings: res.warnings.length ? res.warnings : undefined,
        });
      } else {
        outcomes.push({
          name,
          probe: status,
          outcome: "rearm-failed",
          attempts: st.attempts,
          warnings: res.warnings.length ? res.warnings : undefined,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcomes.push({ name, probe: status, outcome: "rearm-failed", attempts: st.attempts, warnings: [msg] });
    }
  }

  return { outcomes, reArmed, degraded };
}

export type RecoveryDisplayState = "recovering" | "degraded";

/**
 * Compact recovery-state snapshot for UI surfacing (the `/cameras` REC badge,
 * an Overview count). Pure read of the in-memory state — no I/O.
 * "recovering" = at least one re-arm attempt made, not yet exhausted;
 * "degraded" = exhausted `rearmMaxAttempts` and still not recording.
 * Sensors with no recorded state (healthy, or never probed) are absent.
 */
export function getRecoveryStates(): Map<string, RecoveryDisplayState> {
  const out = new Map<string, RecoveryDisplayState>();
  for (const [name, st] of state) {
    if (st.degraded) out.set(name, "degraded");
    else if (st.attempts > 0) out.set(name, "recovering");
  }
  return out;
}

/** Test-only: clear all in-memory recovery state between test cases. */
export function _resetRecoveryStateForTests(): void {
  state.clear();
}
