import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({
    readNamespacedConfigMap: vi.fn(),
    patchNamespacedConfigMap: vi.fn(),
    replaceNamespacedConfigMap: vi.fn(),
  })),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
}));

// Force legacy layout so VST namespace/ConfigMap names match test assertions.
// Legacy shares one ConfigMap + Deployment kind across both components; the
// Helm path (not exercised here) splits them — see cluster-refs.ts.
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    legacy: true,
    vst: {
      namespace: "vst",
      sensorConfigMap: "vst-config",
      streamProcessingConfigMap: "vst-config",
      configKey: "vst_config.json",
      sensorDeployment: "sensor-ms",
      sensorKind: "Deployment",
      streamProcessingDeployment: "streamprocessing-ms",
      streamProcessingKind: "Deployment",
      sensorListUrl: "http://sensor-ms.vst.svc.cluster.local:30000/api/v1/live/sensor/list",
    },
  },
}));

vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn(),
  patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
  replaceConfigMapData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/errors", () => ({
  extractK8sError: vi.fn((err: unknown) => {
    if (err !== null && typeof err === "object") {
      const e = err as { code?: number; message?: string };
      return { status: e.code ?? 500, message: e.message ?? "kubernetes error" };
    }
    return { status: 500, message: String(err) };
  }),
}));

vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn().mockResolvedValue({}),
  inspectContainer: vi.fn().mockResolvedValue(null),
  execInContainer: vi.fn().mockResolvedValue(null),
  dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc123" }),
  DOCKER_TUNING_DIR: "/tmp/test-tuning",
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("no file")),
  },
}));

// The VST route fetches the sensor list via global fetch — stub it out.
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    ok: false,
    json: vi.fn().mockResolvedValue(null),
  }),
);

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { rolloutRestart } from "@/lib/k8s";
import { readConfigMapKey, patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";

import { GET, PATCH } from "@/app/api/tuning/vst/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, body?: unknown): NextRequest {
  return new Request("http://localhost/api/tuning/vst", {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  }) as unknown as NextRequest;
}

// A minimal valid VstConfigJson as stored in the ConfigMap.
const MOCK_VST_CONFIG = {
  onvif: { default_gov_length: 60 },
  data: {
    always_recording: true,
    event_recording: false,
    event_record_length_secs: 10,
    record_buffer_length_secs: 0,
    supported_video_codecs: ["h264", "h265"],
    storage_threshold_percentage: 95,
    storage_monitoring_frequency_secs: 2,
    default_file_expiry_minutes: 10080,
    enable_aging_policy: false,
    recorder_enable_frame_drop: false,
  },
};

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(rolloutRestart).mockReset().mockResolvedValue(undefined);
  vi.mocked(readConfigMapKey).mockReset().mockResolvedValue({
    value: MOCK_VST_CONFIG,
    raw: JSON.stringify(MOCK_VST_CONFIG, null, 2),
    resourceVersion: "55",
  } as never);
  vi.mocked(patchConfigMapRawKey).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  // sensor list fetch fails by default (no live cluster)
  vi.mocked(fetch).mockResolvedValue({
    ok: false,
    json: vi.fn().mockResolvedValue(null),
  } as never);

  delete process.env.CONSOLE_RUNTIME;
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/tuning/vst", () => {
  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("happy path: ConfigMap readable → returns derived VstTuningResponse fields", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    // always_recording=true, event_recording=false → recordingMode="always"
    expect(body.recordingMode).toBe("always");
    expect(body.eventRecordLengthSecs).toBe(10);
    expect(body.recordBufferLengthSecs).toBe(0);
    expect(body.defaultGovLength).toBe(60);
    expect(body.supportedVideoCodecs).toEqual(["h264", "h265"]);
    expect(body.storageThresholdPercentage).toBe(95);
    expect(body.enableAgingPolicy).toBe(false);
    expect(body.recorderEnableFrameDrop).toBe(false);
    // sensor list unavailable → no observed field
    expect(body.observed).toBeUndefined();
  });

  it("ConfigMap read fails → returns error status from extractK8sError", async () => {
    vi.mocked(readConfigMapKey).mockRejectedValue(
      Object.assign(new Error("not found"), { code: 404 }),
    );

    const res = await GET();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.k8sCode).toBe(404);
  });

  it("both always_recording and event_recording true → recordingMode='both'", async () => {
    vi.mocked(readConfigMapKey).mockResolvedValue({
      value: {
        ...MOCK_VST_CONFIG,
        data: { ...MOCK_VST_CONFIG.data, always_recording: true, event_recording: true },
      },
      raw: "{}",
      resourceVersion: "99",
    } as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recordingMode).toBe("both");
  });

  it("sensor list returns entries → observed.sensors populated", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        sensors: [
          { sensor_id: "cam1", bitrate_mbps: 2.5, gov_length: 30 },
        ],
      }),
    } as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.observed).toBeDefined();
    expect(body.observed.sensors).toHaveLength(1);
    expect(body.observed.sensors[0].sensorId).toBe("cam1");
    expect(body.observed.sensors[0].bitrateMbps).toBe(2.5);
    expect(body.observed.sensors[0].gop).toBe(30);
  });

  it.todo("docker mode GET: reads vst_config via execInContainer — deep branch deferred");
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/tuning/vst", () => {
  it("auth missing → 401, no K8s calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("PATCH", { recordingMode: "event" });
    const res = await PATCH(req);

    expect(res.status).toBe(401);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("kiosk mode → 403, no K8s calls", async () => {
    vi.mocked(rejectIfKiosk).mockResolvedValue(
      NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 }),
    );

    const req = makeRequest("PATCH", { recordingMode: "always" });
    const res = await PATCH(req);

    expect(res.status).toBe(403);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("invalid body: empty object (no fields) → 400 (refine fails), no K8s calls", async () => {
    const req = makeRequest("PATCH", {});
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("invalid body: recordingMode not in enum → 400", async () => {
    const req = makeRequest("PATCH", { recordingMode: "continuous" });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("forbidden body: cloud_storage_* field → 400 with forbidden list, no K8s calls", async () => {
    const req = makeRequest("PATCH", {
      recordingMode: "always",
      enable_cloud_storage: true,
    });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.forbidden).toBeDefined();
    expect(body.forbidden).toContain("enable_cloud_storage");
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("happy path: recordingMode='event' → ConfigMap read+write, both deployments restarted, audit logged, 200 ok:true", async () => {
    const req = makeRequest("PATCH", { recordingMode: "event" });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied.recordingMode).toBe("event");

    // ConfigMap read then write
    expect(readConfigMapKey).toHaveBeenCalledWith("vst", "vst-config", "vst_config.json");
    expect(patchConfigMapRawKey).toHaveBeenCalledWith(
      "vst",
      "vst-config",
      "vst_config.json",
      expect.stringContaining('"always_recording": false'),
      "55",
    );
    // Both VST deployments restarted
    expect(rolloutRestart).toHaveBeenCalledWith("Deployment", "vst", "sensor-ms");
    expect(rolloutRestart).toHaveBeenCalledWith("Deployment", "vst", "streamprocessing-ms");
    expect(auditLog).toHaveBeenCalledWith(
      "tuning-vst",
      expect.stringContaining("vst-config"),
      expect.objectContaining({ patches: expect.objectContaining({ recordingMode: "event" }) }),
    );
  });

  it("ConfigMap read fails during PATCH → error status, no write, no audit", async () => {
    vi.mocked(readConfigMapKey).mockRejectedValue(
      Object.assign(new Error("cm read failed"), { code: 503 }),
    );

    const req = makeRequest("PATCH", { enableAgingPolicy: true });
    const res = await PATCH(req);

    expect(res.status).toBe(503);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("ConfigMap write fails → error from extractK8sError, no audit", async () => {
    vi.mocked(patchConfigMapRawKey).mockRejectedValue(
      Object.assign(new Error("write conflict"), { code: 409 }),
    );

    const req = makeRequest("PATCH", { defaultGovLength: 30 });
    const res = await PATCH(req);

    expect(res.status).toBe(409);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("rollout restart of sensor-ms fails → 502, audit not called", async () => {
    vi.mocked(rolloutRestart).mockRejectedValue(new Error("restart failed"));

    const req = makeRequest("PATCH", { storageThresholdPercentage: 80 });
    const res = await PATCH(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/rollout restart of deployment\/sensor-ms failed/i);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it.todo("docker mode PATCH: writes vst_config via execInContainer + restarts containers via dockerSock — deep branch deferred");
});
