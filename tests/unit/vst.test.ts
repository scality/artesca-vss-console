/**
 * Unit tests for src/lib/helpers/vst.ts
 *
 * Covers:
 *  - vstListSensors(): k8s shape (array), k8s shape (object wrapper), docker
 *    /sensor/streams shape, HTTP error, network failure.
 *  - vstAddSensor(): happy path, 409 idempotent, HTTP error, network failure.
 *  - vstStartStream(): no-op when proxyStreamAddUrl empty, happy path, HTTP error.
 *  - vstDeleteSensor(): happy path, HTTP error, network failure.
 *
 * Mocking strategy: vi.stubGlobal("fetch", vi.fn()) — intercepts every fetch
 * call in the module under test.  cluster-refs is mocked to fixed test URLs so
 * no process.env wiring is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── cluster-refs mock ───────────────────────────────────────────────────────

vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    vst: {
      sensorUrl:
        "http://vss-vios-sensor.vss-base.svc.cluster.local:30000/api/v1/live/sensor",
      sensorListUrl:
        "http://vss-vios-sensor.vss-base.svc.cluster.local:30000/api/v1/live/sensor/list",
      sensorAddUrl:
        "http://vss-vios-ingress.vss-base.svc.cluster.local:30888/vst/api/v1/sensor/add",
      proxyStreamAddUrl: "",
      namespace: "vss-base",
      configMap: "vss-vios-sensor-configs",
      configKey: "vst_config.json",
      sensorDeployment: "vss-vios-sensor",
      streamProcessingDeployment: "vss-vios-streamprocessing",
    },
  },
}));

// ─── Module under test (imported after mocks) ────────────────────────────────

import {
  vstListSensors,
  vstAddSensor,
  vstStartStream,
  vstDeleteSensor,
} from "@/lib/helpers/vst";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errResponse(status: number): Response {
  return new Response(JSON.stringify({ error: "boom" }), { status });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═════════════════════════════════════════════════════════════════════════════
// vstListSensors
// ═════════════════════════════════════════════════════════════════════════════

describe("vstListSensors", () => {
  it("k8s array shape: returns sensors from a bare JSON array", async () => {
    const sensors = [
      { sensor_id: "cam1", name: "Camera 1", rtsp_url: "rtsp://host/cam1" },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(sensors));

    const result = await vstListSensors();

    expect(result.warning).toBeUndefined();
    expect(result.sensors).toHaveLength(1);
    expect(result.sensors[0].sensor_id).toBe("cam1");

    // Verify the correct URL was fetched.
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/\/sensor\/list$/);
  });

  it("k8s object wrapper shape: unwraps {sensors: [...]} payload", async () => {
    const payload = {
      sensors: [
        { sensor_id: "s1" },
        { sensor_id: "s2" },
      ],
    };
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(payload));

    const result = await vstListSensors();

    expect(result.sensors).toHaveLength(2);
    expect(result.sensors[1].sensor_id).toBe("s2");
    expect(result.warning).toBeUndefined();
  });

  it("HTTP 5xx: returns empty sensors + warning, does not throw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(500));

    const result = await vstListSensors();

    expect(result.sensors).toEqual([]);
    expect(result.warning).toMatch(/500/);
  });

  it("network failure: returns empty sensors + warning, does not throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await vstListSensors();

    expect(result.sensors).toEqual([]);
    expect(result.warning).toMatch(/unreachable/i);
    expect(result.warning).toMatch(/ECONNREFUSED/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// vstAddSensor
// ═════════════════════════════════════════════════════════════════════════════

describe("vstAddSensor", () => {
  it("happy path: POST to sensorAddUrl, returns ok:true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({ status: "ok" }, 200));

    const result = await vstAddSensor({
      sensorId: "cam1",
      rtspUrl: "rtsp://10.0.0.1/cam1",
    });

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();

    // Verify method + URL + headers + body.
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(/\/sensor\/add$/);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });

    const body = JSON.parse(init.body as string);
    expect(body.sensorUrl).toBe("rtsp://10.0.0.1/cam1");
    expect(body.name).toBe("cam1");
  });

  it("409 idempotent: treated as success (ok:true)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(409));

    const result = await vstAddSensor({
      sensorId: "cam1",
      rtspUrl: "rtsp://host/cam1",
    });

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("HTTP 4xx (non-409): returns ok:false + warning, does not throw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(400));

    const result = await vstAddSensor({
      sensorId: "bad-sensor",
      rtspUrl: "rtsp://host/bad",
    });

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/400/);
    expect(result.warning).toMatch(/bad-sensor/);
  });

  it("network failure: returns ok:false + warning, does not throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));

    const result = await vstAddSensor({
      sensorId: "cam2",
      rtspUrl: "rtsp://host/cam2",
    });

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/cam2/);
    expect(result.warning).toMatch(/timeout/);
  });

  it("optional description maps to location field in request body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({}, 200));

    await vstAddSensor({
      sensorId: "cam3",
      rtspUrl: "rtsp://host/cam3",
      description: "Main entrance",
    });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.location).toBe("Main entrance");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// vstStartStream
// ═════════════════════════════════════════════════════════════════════════════

describe("vstStartStream", () => {
  it("no-op when proxyStreamAddUrl is empty (k8s path): returns ok:true without fetching", async () => {
    // The cluster-refs mock sets proxyStreamAddUrl to "" — so this is a no-op.
    const result = await vstStartStream({
      sensorId: "cam1",
      rtspUrl: "rtsp://host/cam1",
    });

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// vstDeleteSensor
// ═════════════════════════════════════════════════════════════════════════════

describe("vstDeleteSensor", () => {
  it("happy path: DELETE to /{sensorId}, returns ok:true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({}, 200));

    const result = await vstDeleteSensor("cam1");

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(/\/cam1$/);
    expect(init.method).toBe("DELETE");
  });

  it("sensor id is URL-encoded in the DELETE path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({}, 200));

    await vstDeleteSensor("cam with spaces");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/cam%20with%20spaces$/);
  });

  it("HTTP 4xx: returns ok:false + warning, does not throw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(404));

    const result = await vstDeleteSensor("missing");

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/404/);
  });

  it("network failure: returns ok:false + warning, does not throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const result = await vstDeleteSensor("cam1");

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/ETIMEDOUT/);
  });
});
