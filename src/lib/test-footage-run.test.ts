import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/helpers/vst-register", () => ({ registerSensorAndArm: vi.fn() }));
vi.mock("@/lib/helpers/vst", () => ({ vstDeleteSensor: vi.fn(), vstListSensors: vi.fn() }));
vi.mock("@/lib/helpers/ingestion", () => ({
  setIngestion: vi.fn(),
  suspendIngestion: vi.fn(),
  listIngestingCameras: vi.fn(),
}));
vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn(),
  patchConfigMapRawKey: vi.fn(),
}));
vi.mock("@/lib/k8s", () => ({
  rolloutRestart: vi.fn(),
  waitForRollout: vi.fn(),
  quiesceDeployment: vi.fn(),
  scaleDeployment: vi.fn(),
}));

import { registerSensorAndArm } from "@/lib/helpers/vst-register";
import { vstDeleteSensor, vstListSensors } from "@/lib/helpers/vst";
import { setIngestion, suspendIngestion, listIngestingCameras } from "@/lib/helpers/ingestion";
import { readConfigMapKey, patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { rolloutRestart, waitForRollout, quiesceDeployment, scaleDeployment } from "@/lib/k8s";
import { listAlertProfiles, pausedSensors, startRun, stopRun } from "./test-footage-run";

const register = vi.mocked(registerSensorAndArm);
const delSensor = vi.mocked(vstDeleteSensor);
const listSensors = vi.mocked(vstListSensors);
const ingestion = vi.mocked(setIngestion);
const listIngesting = vi.mocked(listIngestingCameras);
const suspend = vi.mocked(suspendIngestion);
const readCm = vi.mocked(readConfigMapKey);
const patchCm = vi.mocked(patchConfigMapRawKey);
const restart = vi.mocked(rolloutRestart);
const waitRollout = vi.mocked(waitForRollout);
const quiesce = vi.mocked(quiesceDeployment);
const scale = vi.mocked(scaleDeployment);

beforeEach(() => {
  vi.resetAllMocks();
  ingestion.mockResolvedValue({ ok: true });
  suspend.mockResolvedValue({ ok: true });
  delSensor.mockResolvedValue({ ok: true });
  register.mockResolvedValue({ ok: true, uuid: "u1", warnings: [] });
  // First call = the cameras to pause; the verification call that follows sees
  // them gone, which is the normal case (the pause took).
  listIngesting
    .mockResolvedValueOnce({ ingesting: new Set(["checkout-1", "pyramid-16-cam0"]) })
    .mockResolvedValue({ ingesting: new Set() });
  listSensors.mockResolvedValue({ sensors: [] } as unknown as Awaited<
    ReturnType<typeof vstListSensors>
  >);
  readCm.mockResolvedValue({
    value: { rules: [{ sensor: "checkout-1" }] },
    raw: "{}",
    resourceVersion: "1",
  } as unknown as Awaited<ReturnType<typeof readConfigMapKey>>);
  patchCm.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof patchConfigMapRawKey>>);
  restart.mockResolvedValue(undefined);
  waitRollout.mockResolvedValue(true);
  quiesce.mockResolvedValue({ previousReplicas: 1, quiesced: true });
  scale.mockResolvedValue(undefined);
});

describe("startRun", () => {
  it("registers the file as a camera and turns analysis on", async () => {
    const res = await startRun({ fileName: "Theft Lane 3.mp4", mode: "loop", pauseLive: false });

    expect(res.cameraId).toBe("test-theft-lane-3");
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "test-theft-lane-3",
        rtspUrl: "rtsp://test-footage-server.console.svc.cluster.local:8654/loop/theft-lane-3.mp4",
      }),
    );
    // Analysis on for the test camera — without this it records but never
    // produces a caption, so nothing can be judged.
    expect(ingestion).toHaveBeenCalledWith(
      "test-theft-lane-3",
      true,
      expect.any(String),
      expect.anything(),
    );
  });

  it("judges the clip against the chosen scenario, not the generic default", async () => {
    const res = await startRun({
      fileName: "clip.mp4",
      mode: "loop",
      pauseLive: false,
      alertType: "self-checkout-theft",
      prompt: "Retail self-checkout area. Alert on a person concealing merchandise.",
    });

    expect(res.alertType).toBe("self-checkout-theft");
    // The alert_type + prompt are what the VLM is actually told to look for.
    // Scenarios only keyword-match the caption afterwards, so a run left on the
    // default asks for "anything notable" and tests no scenario at all.
    expect(ingestion).toHaveBeenCalledWith("test-clip", true, expect.any(String), {
      alertType: "self-checkout-theft",
      prompt: "Retail self-checkout area. Alert on a person concealing merchandise.",
    });
  });

  it("reports the default profile when no scenario is chosen", async () => {
    const res = await startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: false });
    expect(res.alertType).toBe("general-activity");
  });

  it("pauses only the live cameras when asked, never itself", async () => {
    const res = await startRun({ fileName: "clip.mp4", mode: "once", pauseLive: true });

    expect(res.pausedCameras.sort()).toEqual(["checkout-1", "pyramid-16-cam0"]);
    // Suspend, not setIngestion(false): the latter deletes the camera's desired
    // spec from the ConfigMap, which is exactly what a resume reads back.
    expect(suspend).toHaveBeenCalledWith("checkout-1");
    expect(suspend).toHaveBeenCalledWith("pyramid-16-cam0");
    expect(ingestion).not.toHaveBeenCalledWith("checkout-1", false);
    expect(ingestion).not.toHaveBeenCalledWith("pyramid-16-cam0", false);
  });

  it("records the paused set so the reconciler cannot re-seed them mid-run", async () => {
    await startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: true });

    const written = patchCm.mock.calls.map((c) => String(c[3]));
    const withPaused = written.find((w) => w.includes("paused_sensors"));
    expect(withPaused).toBeDefined();
    expect(JSON.parse(withPaused as string).paused_sensors.sort()).toEqual([
      "checkout-1",
      "pyramid-16-cam0",
    ]);
    // The marker alone is not enough: the reconciler reads a mounted copy that
    // lags 60-90s, so it must be restarted to see it before the next tick.
    expect(restart).toHaveBeenCalledWith("Deployment", expect.any(String), "vlm-stream-reconciler");
  });

  it("waits for the reconciler restart to finish before suspending anything", async () => {
    const order: string[] = [];
    waitRollout.mockImplementation(async () => {
      order.push("waited");
      return true;
    });
    suspend.mockImplementation(async (id: string) => {
      order.push(`suspend:${id}`);
      return { ok: true };
    });

    await startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: true });

    // Restarting without waiting is what actually broke the pause on the live
    // showroom: the outgoing pod keeps ticking every 15s against its stale
    // mount, so it re-seeded the cameras seconds after they were suspended.
    expect(order[0]).toBe("waited");
    expect(order.slice(1).every((s) => s.startsWith("suspend:"))).toBe(true);
  });

  it("stops the reconciler before suspending, and starts it again after", async () => {
    const order: string[] = [];
    quiesce.mockImplementation(async () => {
      order.push("quiesce");
      return { previousReplicas: 1, quiesced: true };
    });
    suspend.mockImplementation(async (id: string) => {
      order.push(`suspend:${id}`);
      return { ok: true };
    });
    scale.mockImplementation(async () => {
      order.push("scale-back");
    });

    await startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: true });

    // Measured on the showroom: a restarted-but-not-stopped reconciler issued
    // rule-creating POSTs after the rollout reported complete, because maxSurge
    // overlaps the pods and the outgoing one keeps ticking for its 30s grace.
    // Only "no pod exists" makes the suspend window safe.
    expect(order[0]).toBe("quiesce");
    expect(order[order.length - 1]).toBe("scale-back");
    expect(order.filter((s) => s.startsWith("suspend:"))).toHaveLength(2);
  });

  it("restores the reconciler even when a suspend throws", async () => {
    suspend.mockRejectedValue(new Error("alert-bridge exploded"));

    await expect(
      startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: true }),
    ).rejects.toThrow();

    // Leaving it at zero replicas would silently stop every caption task from
    // ever being re-fired — a far worse outcome than the failed run.
    expect(scale).toHaveBeenCalledWith(expect.any(String), "vlm-stream-reconciler", 1);
  });

  it("warns rather than pretending, when the reconciler will not stop", async () => {
    quiesce.mockResolvedValue({ previousReplicas: 1, quiesced: false });
    const res = await startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: true });
    expect(res.warnings.join(" ")).toMatch(/did not stop in time/);
  });

  it("says so when the restart does not complete, instead of claiming the pause holds", async () => {
    waitRollout.mockResolvedValue(false);
    const res = await startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: true });
    expect(res.warnings.join(" ")).toMatch(/did not finish restarting/);
  });

  it("re-pauses a camera the reconciler re-seeded, and reports it", async () => {
    listIngesting.mockReset();
    listIngesting.mockResolvedValue({ ingesting: new Set(["checkout-1", "pyramid-16-cam0"]) });

    const res = await startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: true });

    // Both were suspended, then found live again on the verification read.
    expect(suspend.mock.calls.filter((c) => c[0] === "checkout-1")).toHaveLength(2);
    expect(res.warnings.join(" ")).toMatch(/re-paused .*checkout-1/);
  });

  it("does not pause anything when pauseLive is false", async () => {
    await startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: false });
    expect(suspend).not.toHaveBeenCalled();
  });

  it("restores the live cameras when registration fails", async () => {
    register.mockResolvedValue({ ok: false, warnings: ["VST add returned HTTP 500"] });

    await expect(
      startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: true }),
    ).rejects.toThrow(/could not register/);

    // The showroom must not be left with its analysis switched off because a
    // test failed to start.
    expect(ingestion).toHaveBeenCalledWith("checkout-1", true);
    expect(ingestion).toHaveBeenCalledWith("pyramid-16-cam0", true);
  });

  it("rejects a file whose name is not usable footage", async () => {
    await expect(
      startRun({ fileName: "notes.txt", mode: "loop", pauseLive: false }),
    ).rejects.toThrow(/unsupported video format/);
    expect(register).not.toHaveBeenCalled();
  });
});

describe("stopRun", () => {
  beforeEach(() => {
    listSensors.mockResolvedValue({
      sensors: [
        { sensor_id: "test-clip", streamId: "uuid-test" },
        { sensor_id: "checkout-1", streamId: "uuid-live" },
      ],
    } as unknown as Awaited<ReturnType<typeof vstListSensors>>);
  });

  it("removes only test cameras and resumes the paused live ones", async () => {
    const res = await stopRun({ cameraId: "test-clip", resume: ["checkout-1"] });

    expect(res.stopped).toEqual(["test-clip"]);
    // Deleted by UUID — VST keys removal on it, not the name.
    expect(delSensor).toHaveBeenCalledWith("uuid-test");
    // The live camera is resumed, never deleted.
    expect(delSensor).not.toHaveBeenCalledWith("uuid-live");
    expect(ingestion).toHaveBeenCalledWith("checkout-1", true);
  });

  it("resumes cameras the ConfigMap says are paused, not just the caller's list", async () => {
    // The caller's list lives in the browser tab that started the run. When that
    // tab is gone — the exact case that left the showroom analysing nothing —
    // the ConfigMap marker is the only record of what was paused.
    readCm.mockResolvedValue({
      value: { rules: [], paused_sensors: ["pyramid-16-cam0", "pyramid-18-cam1"] },
      raw: "{}",
      resourceVersion: "1",
    } as unknown as Awaited<ReturnType<typeof readConfigMapKey>>);

    const res = await stopRun({ resume: [] });

    expect(res.resumed.sort()).toEqual(["pyramid-16-cam0", "pyramid-18-cam1"]);
    expect(ingestion).toHaveBeenCalledWith("pyramid-16-cam0", true);
    expect(ingestion).toHaveBeenCalledWith("pyramid-18-cam1", true);
  });

  it("never tries to resume a test camera it just deleted", async () => {
    readCm.mockResolvedValue({
      value: { rules: [], paused_sensors: ["test-clip", "checkout-1"] },
      raw: "{}",
      resourceVersion: "1",
    } as unknown as Awaited<ReturnType<typeof readConfigMapKey>>);

    const res = await stopRun({ resume: [] });

    expect(res.resumed).toEqual(["checkout-1"]);
    expect(ingestion).not.toHaveBeenCalledWith("test-clip", true);
  });

  it("cleans up every abandoned test camera when none is named", async () => {
    listSensors.mockResolvedValue({
      sensors: [
        { sensor_id: "test-a", streamId: "ua" },
        { sensor_id: "test-b", streamId: "ub" },
        { sensor_id: "pyramid-18-cam1", streamId: "ul" },
      ],
    } as unknown as Awaited<ReturnType<typeof vstListSensors>>);

    const res = await stopRun({ resume: [] });

    expect(res.stopped.sort()).toEqual(["test-a", "test-b"]);
    expect(delSensor).not.toHaveBeenCalledWith("ul");
  });
});

describe("listAlertProfiles", () => {
  it("offers each configured alert type once, naming the cameras that use it", async () => {
    readCm.mockResolvedValue({
      value: {
        rules: [
          { sensor: "checkout-1", alert_type: "self-checkout-theft", prompt: "Theft prompt." },
          { sensor: "pyramid-16-cam0", alert_type: "self-checkout-theft", prompt: "Theft prompt." },
          { sensor: "pyramid-18-cam0", alert_type: "shelf-restock", prompt: "Restock prompt." },
        ],
      },
      raw: "{}",
      resourceVersion: "1",
    } as unknown as Awaited<ReturnType<typeof readConfigMapKey>>);

    const profiles = await listAlertProfiles();

    expect(profiles.map((p) => p.alertType)).toEqual(["self-checkout-theft", "shelf-restock"]);
    expect(profiles[0].cameras).toEqual(["checkout-1", "pyramid-16-cam0"]);
    expect(profiles[0].prompt).toBe("Theft prompt.");
  });

  it("does not offer a previous run's ad-hoc choice back as production config", async () => {
    readCm.mockResolvedValue({
      value: {
        rules: [
          { sensor: "checkout-1", alert_type: "self-checkout-theft", prompt: "Theft prompt." },
          { sensor: "test-clip", alert_type: "whatever-i-typed", prompt: "Ad-hoc." },
        ],
      },
      raw: "{}",
      resourceVersion: "1",
    } as unknown as Awaited<ReturnType<typeof readConfigMapKey>>);

    const profiles = await listAlertProfiles();
    expect(profiles.map((p) => p.alertType)).toEqual(["self-checkout-theft"]);
  });

  it("falls back to the generic profile rather than an empty picker", async () => {
    readCm.mockRejectedValue(new Error("configmap unreachable"));
    const profiles = await listAlertProfiles();
    expect(profiles).toEqual([
      {
        alertType: "general-activity",
        prompt: "Alert on any notable or anomalous activity.",
        cameras: [],
      },
    ]);
  });
});

describe("pausedSensors", () => {
  it("reports the marker so an abandoned pause is visible", async () => {
    readCm.mockResolvedValue({
      value: { rules: [], paused_sensors: ["checkout-1"] },
      raw: "{}",
      resourceVersion: "1",
    } as unknown as Awaited<ReturnType<typeof readConfigMapKey>>);
    expect(await pausedSensors()).toEqual(["checkout-1"]);
  });

  it("reports nothing rather than throwing when the ConfigMap cannot be read", async () => {
    readCm.mockRejectedValue(new Error("nope"));
    expect(await pausedSensors()).toEqual([]);
  });
});
