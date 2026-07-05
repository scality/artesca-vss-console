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
  /**
   * Master switch for the pod-restart escalation. When many previously-recording
   * sensors stall at once (pod-global recorder-stall failure mode), per-sensor
   * delete+re-add can't recover them — a streamprocessing rollout-restart is the
   * blunt escalation. Disable to keep only the per-sensor re-arm behavior.
   */
  escalateEnabled: boolean;
  /**
   * Minimum count of recoverable-stalled sensors (were recording, now stalled
   * past the threshold) needed to trigger a streamprocessing restart.
   */
  escalateMinStalled: number;
  /** Minimum time between escalation restarts. */
  escalateCooldownMs: number;
  /** Cap on escalation restarts before giving up. */
  escalateMaxRestarts: number;
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  stallThresholdMs: 300_000,
  rearmCooldownMs: 600_000,
  rearmMaxAttempts: 3,
  rearmMaxPerCycle: 1,
  escalateEnabled: true,
  escalateMinStalled: 3,
  escalateCooldownMs: 300_000,
  escalateMaxRestarts: 2,
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
  /** True iff a streamprocessing restart was fired this cycle (pod-restart escalation). */
  escalated: boolean;
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

/**
 * Sensor names that have EVER probed "recording". A name is added whenever its
 * probe returns "recording" and is deliberately NOT removed on the subsequent
 * `state.delete(name)` — so it survives recording→not-recording cycles. It
 * discriminates "was working, now stalled" (an escalation-eligible stall) from
 * "never-worked / genuinely-offline" cameras (which must not drive escalation).
 */
const everRecorded = new Set<string>();

/**
 * Module-level escalation bookkeeping for the pod-restart escalation: when the
 * last streamprocessing restart fired, and how many have fired so far (capped
 * by `escalateMaxRestarts`, gated by `escalateCooldownMs`).
 */
const escalationState: { lastEscalationAt?: number; restarts: number } = { restarts: 0 };

export interface RecoverStalledRecordingDeps {
  /** Live VST sensors this cycle (any status — only ONLINE ones are acted on). */
  sensors: VstSensor[];
  /** Desired camera definitions, for rtspUrl resolution on re-arm. */
  desired: CameraEntry[];
  /** Ground-truth recording probe (injected for testability). */
  probe: (streamId: string) => Promise<RecordingStatus>;
  /** Re-arm action (injected for testability). */
  rearm: (name: string, rtspUrl: string, streamId: string) => Promise<{ ok: boolean; warnings: string[] }>;
  /**
   * Escalation action (injected for testability): rollout-restart the VST
   * streamprocessing workload. Fired when enough previously-recording sensors
   * stall at once for the per-sensor re-arm to keep up. Absent = no escalation.
   */
  restartStreamProcessing?: () => Promise<void>;
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
  const stalledRecoverable: string[] = [];
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
      everRecorded.add(name);
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

    const pastThreshold = nowMs - st.notRecordingSince > cfg.stallThresholdMs;
    // Escalation-eligible = past the stall threshold AND known to have recorded
    // before. Captured regardless of the per-sensor outcome below (degraded,
    // waiting, or rearmed) so the pod-global count reflects the true stall size.
    if (pastThreshold && everRecorded.has(name)) {
      stalledRecoverable.push(name);
    }

    if (st.attempts >= cfg.rearmMaxAttempts) {
      st.degraded = true;
      degraded.push(name);
      outcomes.push({ name, probe: status, outcome: "degraded", attempts: st.attempts });
      continue;
    }

    const cooldownElapsed = st.lastRearmAt === undefined || nowMs - st.lastRearmAt > cfg.rearmCooldownMs;
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

  // Pod-restart escalation (fail-soft — must never throw). When enough
  // previously-recording sensors are stalled at once, per-sensor re-arm can't
  // recover a pod-global recorder stall — rollout-restart streamprocessing,
  // subject to a cooldown and a hard cap. Per-sensor timers are deliberately
  // left untouched (the cap relies on them staying put while stalled).
  const nowMsEnd = now();
  let escalated = false;
  if (cfg.escalateEnabled && deps.restartStreamProcessing && stalledRecoverable.length >= cfg.escalateMinStalled) {
    const cooldownOk = escalationState.lastEscalationAt === undefined
      || nowMsEnd - escalationState.lastEscalationAt > cfg.escalateCooldownMs;
    const capOk = escalationState.restarts < cfg.escalateMaxRestarts;
    if (cooldownOk && capOk) {
      try {
        await deps.restartStreamProcessing();
        escalated = true;
        escalationState.lastEscalationAt = nowMsEnd;
        escalationState.restarts += 1;
      } catch (err) {
        deps.log?.warn("recording-recovery: streamprocessing restart threw", { err });
      }
    }
  }
  if (stalledRecoverable.length === 0) {
    escalationState.lastEscalationAt = undefined;
    escalationState.restarts = 0;
  }

  return { outcomes, reArmed, degraded, escalated };
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
  everRecorded.clear();
  escalationState.lastEscalationAt = undefined;
  escalationState.restarts = 0;
}
