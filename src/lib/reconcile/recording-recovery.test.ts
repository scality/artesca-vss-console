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
};

function statusMap(entries: Record<string, RecordingStatus>) {
  return async (streamId: string): Promise<RecordingStatus> => entries[streamId] ?? "unknown";
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
