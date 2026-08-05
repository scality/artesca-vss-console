import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/helpers/vst-register", () => ({ registerSensorAndArm: vi.fn() }));
vi.mock("@/lib/helpers/vst", () => ({ vstDeleteSensor: vi.fn(), vstListSensors: vi.fn() }));
vi.mock("@/lib/helpers/ingestion", () => ({
  setIngestion: vi.fn(),
  listIngestingCameras: vi.fn(),
}));

import { registerSensorAndArm } from "@/lib/helpers/vst-register";
import { vstDeleteSensor, vstListSensors } from "@/lib/helpers/vst";
import { setIngestion, listIngestingCameras } from "@/lib/helpers/ingestion";
import { startRun, stopRun } from "./test-footage-run";

const register = vi.mocked(registerSensorAndArm);
const delSensor = vi.mocked(vstDeleteSensor);
const listSensors = vi.mocked(vstListSensors);
const ingestion = vi.mocked(setIngestion);
const listIngesting = vi.mocked(listIngestingCameras);

beforeEach(() => {
  vi.resetAllMocks();
  ingestion.mockResolvedValue({ ok: true });
  delSensor.mockResolvedValue({ ok: true });
  register.mockResolvedValue({ ok: true, uuid: "u1", warnings: [] });
  listIngesting.mockResolvedValue({ ingesting: new Set(["checkout-1", "pyramid-16-cam0"]) });
  listSensors.mockResolvedValue({ sensors: [] } as unknown as Awaited<
    ReturnType<typeof vstListSensors>
  >);
});

describe("startRun", () => {
  it("registers the file as a camera and turns analysis on", async () => {
    const res = await startRun({ fileName: "Theft Lane 3.mp4", mode: "loop", pauseLive: false });

    expect(res.cameraId).toBe("test-theft-lane-3");
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "test-theft-lane-3",
        rtspUrl: "rtsp://127.0.0.1:8654/loop/theft-lane-3.mp4",
      }),
    );
    // Analysis on for the test camera — without this it records but never
    // produces a caption, so nothing can be judged.
    expect(ingestion).toHaveBeenCalledWith("test-theft-lane-3", true, expect.any(String));
  });

  it("pauses only the live cameras when asked, never itself", async () => {
    const res = await startRun({ fileName: "clip.mp4", mode: "once", pauseLive: true });

    expect(res.pausedCameras.sort()).toEqual(["checkout-1", "pyramid-16-cam0"]);
    expect(ingestion).toHaveBeenCalledWith("checkout-1", false);
    expect(ingestion).toHaveBeenCalledWith("pyramid-16-cam0", false);
  });

  it("does not pause anything when pauseLive is false", async () => {
    await startRun({ fileName: "clip.mp4", mode: "loop", pauseLive: false });
    expect(ingestion).not.toHaveBeenCalledWith("checkout-1", false);
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
