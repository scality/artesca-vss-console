import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VstSensor } from "@/lib/helpers/vst";
import type { CameraEntry } from "@/lib/config-store/types";
import type { RecordingStatus } from "@/lib/helpers/recording-health";
import {
  recoverStalledRecording,
  getRecoveryStates,
  _resetRecoveryStateForTests,
  type RecoveryConfig,
} from "./recording-recovery";

function mkSensor(name: string, status = "online"): VstSensor {
  return { sensor_id: name, name, status, streamId: name };
}

function mkCamera(name: string, rtspUrl = `rtsp://cam/${name}`): CameraEntry {
  return { id: name, rtspUrl };
}

const CONFIG: RecoveryConfig = {
  stallThresholdMs: 100,
  rearmCooldownMs: 200,
  rearmMaxAttempts: 2,
  rearmMaxPerCycle: 1,
  escalateEnabled: true,
  escalateMinStalled: 2,
  escalateCooldownMs: 1000,
  escalateMaxRestarts: 1,
};

function statusMap(entries: Record<string, RecordingStatus>) {
  return async (streamId: string): Promise<RecordingStatus> => entries[streamId] ?? "unknown";
}

/** Probe returning the same status for every named sensor. */
function allProbe(names: string[], status: RecordingStatus) {
  return statusMap(Object.fromEntries(names.map((n) => [n, status])));
}

function mkFns() {
  return {
    rearm: vi.fn(async () => ({ ok: true, warnings: [] as string[] })),
    restart: vi.fn(async () => {}),
  };
}

/**
 * Bring `names` into the "everRecorded then stalled" state: one "recording"
 * cycle (marks everRecorded, clears any per-sensor state) at t=0, then a first
 * "not-recording" sighting at t=10 (sets notRecordingSince=10). A later
 * past-threshold cycle then counts them as recoverable-stalled.
 */
async function primeEverRecordedThenStall(
  names: string[],
  fns: {
    rearm: (name: string, rtspUrl: string, streamId: string) => Promise<{ ok: boolean; warnings: string[] }>;
    restart?: () => Promise<void>;
  },
  config: RecoveryConfig,
) {
  const sensors = names.map((n) => mkSensor(n));
  const desired = names.map((n) => mkCamera(n));
  await recoverStalledRecording({
    sensors,
    desired,
    probe: allProbe(names, "recording"),
    rearm: fns.rearm,
    restartStreamProcessing: fns.restart,
    now: () => 0,
    config,
  });
  await recoverStalledRecording({
    sensors,
    desired,
    probe: allProbe(names, "not-recording"),
    rearm: fns.rearm,
    restartStreamProcessing: fns.restart,
    now: () => 10,
    config,
  });
}

beforeEach(() => {
  _resetRecoveryStateForTests();
});

describe("recoverStalledRecording", () => {
  it("healthy sensor: no action, no state", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const summary = await recoverStalledRecording({
      sensors: [mkSensor("cam-1")],
      desired: [mkCamera("cam-1")],
      probe: statusMap({ "cam-1": "recording" }),
      rearm,
      now: () => 0,
      config: CONFIG,
    });
    expect(summary.outcomes).toEqual([
      { name: "cam-1", probe: "recording", outcome: "healthy", attempts: 0 },
    ]);
    expect(summary.reArmed).toEqual([]);
    expect(summary.degraded).toEqual([]);
    expect(rearm).not.toHaveBeenCalled();
    expect(getRecoveryStates().size).toBe(0);
  });

  it("not-recording under the stall threshold: no action", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const probe = statusMap({ "cam-1": "not-recording" });
    const deps = { sensors: [mkSensor("cam-1")], desired: [mkCamera("cam-1")], probe, rearm, config: CONFIG };

    // First sighting establishes notRecordingSince=0.
    let summary = await recoverStalledRecording({ ...deps, now: () => 0 });
    expect(summary.outcomes[0].outcome).toBe("waiting");

    // Still short of the 100ms threshold.
    summary = await recoverStalledRecording({ ...deps, now: () => 50 });
    expect(summary.outcomes[0].outcome).toBe("waiting");
    expect(rearm).not.toHaveBeenCalled();
    expect(summary.reArmed).toEqual([]);
  });

  it("not-recording past the stall threshold: exactly one re-arm", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const probe = statusMap({ "cam-1": "not-recording" });
    const deps = { sensors: [mkSensor("cam-1")], desired: [mkCamera("cam-1")], probe, rearm, config: CONFIG };

    await recoverStalledRecording({ ...deps, now: () => 0 }); // establishes notRecordingSince
    const summary = await recoverStalledRecording({ ...deps, now: () => 150 }); // > 100ms threshold

    expect(rearm).toHaveBeenCalledTimes(1);
    expect(rearm).toHaveBeenCalledWith("cam-1", "rtsp://cam/cam-1", "cam-1");
    expect(summary.reArmed).toEqual(["cam-1"]);
    expect(summary.outcomes[0].outcome).toBe("rearmed");
    expect(summary.outcomes[0].attempts).toBe(1);
    expect(getRecoveryStates().get("cam-1")).toBe("recovering");
  });

  it("cooldown blocks a second re-arm right after the first", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const probe = statusMap({ "cam-1": "not-recording" });
    const deps = { sensors: [mkSensor("cam-1")], desired: [mkCamera("cam-1")], probe, rearm, config: CONFIG };

    await recoverStalledRecording({ ...deps, now: () => 0 });
    await recoverStalledRecording({ ...deps, now: () => 150 }); // re-arm #1 at t=150

    // Still not-recording, well past the stall threshold again, but the
    // 200ms cooldown since the t=150 re-arm hasn't elapsed yet.
    const summary = await recoverStalledRecording({ ...deps, now: () => 300 });

    expect(rearm).toHaveBeenCalledTimes(1); // no second call
    expect(summary.reArmed).toEqual([]);
    expect(summary.outcomes[0].outcome).toBe("waiting");
    expect(summary.outcomes[0].attempts).toBe(1); // unchanged
  });

  it("recording again after a re-arm clears the state", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const deps = { sensors: [mkSensor("cam-1")], desired: [mkCamera("cam-1")], rearm, config: CONFIG };

    await recoverStalledRecording({ ...deps, probe: statusMap({ "cam-1": "not-recording" }), now: () => 0 });
    await recoverStalledRecording({ ...deps, probe: statusMap({ "cam-1": "not-recording" }), now: () => 150 });
    expect(getRecoveryStates().get("cam-1")).toBe("recovering");

    const summary = await recoverStalledRecording({
      ...deps,
      probe: statusMap({ "cam-1": "recording" }),
      now: () => 200,
    });

    expect(summary.outcomes[0].outcome).toBe("healthy");
    expect(getRecoveryStates().has("cam-1")).toBe(false);
  });

  it("still not-recording after MAX_ATTEMPTS re-arms goes degraded and stops re-arming", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const probe = statusMap({ "cam-1": "not-recording" });
    const deps = { sensors: [mkSensor("cam-1")], desired: [mkCamera("cam-1")], probe, rearm, config: CONFIG };

    await recoverStalledRecording({ ...deps, now: () => 0 }); // sighting
    await recoverStalledRecording({ ...deps, now: () => 150 }); // re-arm #1 (attempts=1)
    await recoverStalledRecording({ ...deps, now: () => 400 }); // cooldown elapsed (400-150>200) → re-arm #2 (attempts=2, MAX)

    expect(rearm).toHaveBeenCalledTimes(2);

    // MAX_ATTEMPTS (2) reached — next cycle must go degraded without re-arming again.
    const summary = await recoverStalledRecording({ ...deps, now: () => 1000 });
    expect(summary.outcomes[0].outcome).toBe("degraded");
    expect(summary.degraded).toEqual(["cam-1"]);
    expect(rearm).toHaveBeenCalledTimes(2); // unchanged — no further re-arm
    expect(getRecoveryStates().get("cam-1")).toBe("degraded");

    // And it stays degraded, still without re-arming, on later cycles too.
    const again = await recoverStalledRecording({ ...deps, now: () => 5000 });
    expect(again.outcomes[0].outcome).toBe("degraded");
    expect(rearm).toHaveBeenCalledTimes(2);
  });

  it("honors the per-cycle re-arm batch cap across multiple stalled sensors", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const probe = statusMap({ "cam-1": "not-recording", "cam-2": "not-recording" });
    const deps = {
      sensors: [mkSensor("cam-1"), mkSensor("cam-2")],
      desired: [mkCamera("cam-1"), mkCamera("cam-2")],
      probe,
      rearm,
      config: CONFIG, // rearmMaxPerCycle: 1
    };

    await recoverStalledRecording({ ...deps, now: () => 0 }); // both sighted
    const summary = await recoverStalledRecording({ ...deps, now: () => 150 }); // both past threshold

    expect(rearm).toHaveBeenCalledTimes(1); // batch cap of 1 honored
    expect(summary.reArmed).toHaveLength(1);
    const rearmedOutcome = summary.outcomes.find((o) => o.outcome === "rearmed");
    const waitingOutcome = summary.outcomes.find((o) => o.outcome === "waiting");
    expect(rearmedOutcome).toBeDefined();
    expect(waitingOutcome).toBeDefined();
  });

  it("unknown probe never triggers a re-arm, even past the threshold", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const probe = statusMap({}); // "cam-1" resolves to "unknown" (default)
    const deps = { sensors: [mkSensor("cam-1")], desired: [mkCamera("cam-1")], probe, rearm, config: CONFIG };

    await recoverStalledRecording({ ...deps, now: () => 0 });
    const summary = await recoverStalledRecording({ ...deps, now: () => 10_000 });

    expect(summary.outcomes.every((o) => o.outcome === "unknown")).toBe(true);
    expect(rearm).not.toHaveBeenCalled();
    expect(summary.reArmed).toEqual([]);
    expect(getRecoveryStates().size).toBe(0);
  });

  it("skips the re-arm when no rtspUrl is known for the sensor", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const probe = statusMap({ "cam-1": "not-recording" });
    const deps = { sensors: [mkSensor("cam-1")], desired: [], probe, rearm, config: CONFIG }; // no desired entry

    await recoverStalledRecording({ ...deps, now: () => 0 });
    const summary = await recoverStalledRecording({ ...deps, now: () => 150 });

    expect(summary.outcomes[0].outcome).toBe("no-rtsp-url");
    expect(rearm).not.toHaveBeenCalled();
  });

  it("ignores offline sensors entirely", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const probe = statusMap({ "cam-1": "not-recording" });
    const summary = await recoverStalledRecording({
      sensors: [mkSensor("cam-1", "offline")],
      desired: [mkCamera("cam-1")],
      probe,
      rearm,
      now: () => 10_000,
      config: CONFIG,
    });
    expect(summary.outcomes).toEqual([]);
    expect(rearm).not.toHaveBeenCalled();
  });
});

describe("escalation", () => {
  it("fires exactly one streamprocessing restart when >= escalateMinStalled were-recording sensors stall", async () => {
    const { rearm, restart } = mkFns();
    const names = ["cam-1", "cam-2"]; // escalateMinStalled: 2
    await primeEverRecordedThenStall(names, { rearm, restart }, CONFIG);

    const summary = await recoverStalledRecording({
      sensors: names.map((n) => mkSensor(n)),
      desired: names.map((n) => mkCamera(n)),
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 200, // 200-10 > 100 threshold for both
      config: CONFIG,
    });

    expect(restart).toHaveBeenCalledTimes(1);
    expect(summary.escalated).toBe(true);
  });

  it("never-recorded (offline) sensors past threshold do not count — no escalation even in bulk", async () => {
    const { rearm, restart } = mkFns();
    const names = ["off-1", "off-2", "off-3", "off-4"]; // 4 >= escalateMinStalled, but never recorded
    const sensors = names.map((n) => mkSensor(n));
    const desired = names.map((n) => mkCamera(n));

    // No "recording" probe ever — always not-recording.
    await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 0,
      config: CONFIG,
    });
    const summary = await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 500, // well past threshold for all four
      config: CONFIG,
    });

    expect(restart).not.toHaveBeenCalled();
    expect(summary.escalated).toBe(false);
  });

  it("recoverable-stalled count below escalateMinStalled → no escalation", async () => {
    const { rearm, restart } = mkFns();
    const names = ["cam-1"]; // only 1 < escalateMinStalled(2)
    await primeEverRecordedThenStall(names, { rearm, restart }, CONFIG);

    const summary = await recoverStalledRecording({
      sensors: names.map((n) => mkSensor(n)),
      desired: names.map((n) => mkCamera(n)),
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 200,
      config: CONFIG,
    });

    expect(restart).not.toHaveBeenCalled();
    expect(summary.escalated).toBe(false);
  });

  it("cooldown blocks a second restart within escalateCooldownMs", async () => {
    const { rearm, restart } = mkFns();
    const cfg: RecoveryConfig = { ...CONFIG, escalateMaxRestarts: 5, escalateCooldownMs: 1000 };
    const names = ["cam-1", "cam-2"];
    const sensors = names.map((n) => mkSensor(n));
    const desired = names.map((n) => mkCamera(n));
    await primeEverRecordedThenStall(names, { rearm, restart }, cfg);

    // Escalate #1 at t=200.
    await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 200,
      config: cfg,
    });
    expect(restart).toHaveBeenCalledTimes(1);

    // Still stalled, cap not reached — but only 300ms since the last restart (< 1000 cooldown).
    const summary = await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 500,
      config: cfg,
    });
    expect(restart).toHaveBeenCalledTimes(1); // cooldown gated
    expect(summary.escalated).toBe(false);
  });

  it("escalateMaxRestarts caps the number of restarts even past cooldown", async () => {
    const { rearm, restart } = mkFns();
    const names = ["cam-1", "cam-2"]; // CONFIG escalateMaxRestarts: 1, escalateCooldownMs: 1000
    const sensors = names.map((n) => mkSensor(n));
    const desired = names.map((n) => mkCamera(n));
    await primeEverRecordedThenStall(names, { rearm, restart }, CONFIG);

    // Escalate #1 at t=200.
    await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 200,
      config: CONFIG,
    });
    expect(restart).toHaveBeenCalledTimes(1);

    // Past the cooldown (1100ms since #1) but the cap of 1 is reached.
    const summary = await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 1300,
      config: CONFIG,
    });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(summary.escalated).toBe(false);
  });

  it("escalateEnabled:false never escalates", async () => {
    const { rearm, restart } = mkFns();
    const cfg: RecoveryConfig = { ...CONFIG, escalateEnabled: false };
    const names = ["cam-1", "cam-2"];
    await primeEverRecordedThenStall(names, { rearm, restart }, cfg);

    const summary = await recoverStalledRecording({
      sensors: names.map((n) => mkSensor(n)),
      desired: names.map((n) => mkCamera(n)),
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 200,
      config: cfg,
    });

    expect(restart).not.toHaveBeenCalled();
    expect(summary.escalated).toBe(false);
  });

  it("no restartStreamProcessing dep → no escalation and no throw", async () => {
    const { rearm } = mkFns();
    const names = ["cam-1", "cam-2"];
    const sensors = names.map((n) => mkSensor(n));
    const desired = names.map((n) => mkCamera(n));

    // Prime without any restart dep.
    await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "recording"),
      rearm,
      now: () => 0,
      config: CONFIG,
    });
    await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      now: () => 10,
      config: CONFIG,
    });
    const summary = await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      now: () => 200,
      config: CONFIG,
    });

    expect(summary.escalated).toBe(false);
  });

  it("restartStreamProcessing rejection → escalated:false and does not throw", async () => {
    const rearm = vi.fn(async () => ({ ok: true, warnings: [] as string[] }));
    const restart = vi.fn(async () => {
      throw new Error("rollout failed");
    });
    const names = ["cam-1", "cam-2"];
    await primeEverRecordedThenStall(names, { rearm, restart }, CONFIG);

    const summary = await recoverStalledRecording({
      sensors: names.map((n) => mkSensor(n)),
      desired: names.map((n) => mkCamera(n)),
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 200,
      config: CONFIG,
    });

    expect(restart).toHaveBeenCalledTimes(1);
    expect(summary.escalated).toBe(false);
  });

  it("recording again resets escalation counters so a fresh stall can escalate again", async () => {
    const { rearm, restart } = mkFns();
    const names = ["cam-1", "cam-2"]; // escalateMaxRestarts: 1
    const sensors = names.map((n) => mkSensor(n));
    const desired = names.map((n) => mkCamera(n));
    await primeEverRecordedThenStall(names, { rearm, restart }, CONFIG);

    // Escalate #1 at t=200.
    await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 200,
      config: CONFIG,
    });
    expect(restart).toHaveBeenCalledTimes(1);

    // Both recording again → stalledRecoverable empty → escalation counters reset.
    const back = await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 300,
      config: CONFIG,
    });
    expect(back.escalated).toBe(false);

    // Fresh stall: new sighting at t=400, then past-threshold at t=600 → escalates
    // again despite escalateMaxRestarts:1 because the counters were reset.
    await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 400,
      config: CONFIG,
    });
    const again = await recoverStalledRecording({
      sensors,
      desired,
      probe: allProbe(names, "not-recording"),
      rearm,
      restartStreamProcessing: restart,
      now: () => 600,
      config: CONFIG,
    });
    expect(again.escalated).toBe(true);
    expect(restart).toHaveBeenCalledTimes(2);
  });
});
