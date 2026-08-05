import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/helpers/vst", () => ({
  vstAddSensor: vi.fn(),
  vstStartStream: vi.fn(),
  vstListSensors: vi.fn(),
}));

import { vstAddSensor, vstStartStream, vstListSensors } from "@/lib/helpers/vst";
import { registerSensorAndArm, redactRtspUrl } from "./vst-register";

const addSensor = vi.mocked(vstAddSensor);
const startStream = vi.mocked(vstStartStream);
const listSensors = vi.mocked(vstListSensors);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("registerSensorAndArm", () => {
  it("arms the recorder with the UUID VST minted, never the camera name", async () => {
    addSensor.mockResolvedValue({ ok: true, uuid: "uuid-1" });
    startStream.mockResolvedValue({ ok: true });

    const res = await registerSensorAndArm({ name: "checkout-1", rtspUrl: "rtsp://h/s" });

    expect(res.ok).toBe(true);
    expect(res.uuid).toBe("uuid-1");
    // The whole point: arming by name records nothing, silently.
    expect(startStream).toHaveBeenCalledWith({ sensorId: "uuid-1", rtspUrl: "rtsp://h/s" });
  });

  it("resolves the UUID from the live list when add was idempotent (409, no body)", async () => {
    addSensor.mockResolvedValue({ ok: true });
    listSensors.mockResolvedValue({
      sensors: [{ sensor_id: "checkout-1", streamId: "uuid-live" }],
    } as unknown as Awaited<ReturnType<typeof vstListSensors>>);
    startStream.mockResolvedValue({ ok: true });

    const res = await registerSensorAndArm({ name: "checkout-1", rtspUrl: "rtsp://h/s" });

    expect(startStream).toHaveBeenCalledWith({ sensorId: "uuid-live", rtspUrl: "rtsp://h/s" });
    expect(res.uuid).toBe("uuid-live");
  });

  it("warns instead of silently skipping when no UUID can be found", async () => {
    addSensor.mockResolvedValue({ ok: true });
    listSensors.mockResolvedValue({ sensors: [] } as unknown as Awaited<
      ReturnType<typeof vstListSensors>
    >);

    const res = await registerSensorAndArm({ name: "cam-x", rtspUrl: "rtsp://h/s" });

    expect(startStream).not.toHaveBeenCalled();
    expect(res.ok).toBe(true); // registered, just not recording
    expect(res.warnings.join()).toMatch(/will not record/);
  });

  it("reports a failed registration and does not try to arm", async () => {
    addSensor.mockResolvedValue({ ok: false, warning: "VST add returned HTTP 500" });

    const res = await registerSensorAndArm({ name: "cam-x", rtspUrl: "rtsp://h/s" });

    expect(res.ok).toBe(false);
    expect(startStream).not.toHaveBeenCalled();
    expect(res.warnings).toContain("VST add returned HTTP 500");
  });

  it("keeps the camera usable but surfaces a failure to arm", async () => {
    addSensor.mockResolvedValue({ ok: true, uuid: "u" });
    startStream.mockResolvedValue({ ok: false, warning: "proxy/stream/add HTTP 502" });

    const res = await registerSensorAndArm({ name: "cam-x", rtspUrl: "rtsp://h/s" });

    expect(res.ok).toBe(true);
    expect(res.warnings).toContain("proxy/stream/add HTTP 502");
  });
});

describe("redactRtspUrl", () => {
  it("strips embedded credentials", () => {
    expect(redactRtspUrl("rtsp://admin:s3cr3t@10.0.0.5:554/live")).toBe(
      "rtsp://<redacted>@10.0.0.5:554/live",
    );
    expect(redactRtspUrl("rtsps://u:p@h/s")).toBe("rtsps://<redacted>@h/s");
  });

  it("leaves a credential-free URL untouched", () => {
    expect(redactRtspUrl("rtsp://10.172.0.16:8556/video0")).toBe(
      "rtsp://10.172.0.16:8556/video0",
    );
  });

  it("passes undefined through", () => {
    expect(redactRtspUrl(undefined)).toBeUndefined();
  });
});
