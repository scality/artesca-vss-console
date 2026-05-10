/**
 * Unit tests for src/lib/helpers/camsim-control.ts
 *
 * camsim-control.ts is a pure HTTP client that talks to the camera-sim
 * control-plane HTTP API (:8080).  It does NOT use SSH — all operations go
 * through fetch().
 *
 * Mocking strategy: vi.stubGlobal("fetch", vi.fn()) — intercepts every fetch
 * call.  CAMERA_SIM_CONTROL_URL is stubbed to a known base so we control the
 * exact URLs without needing CAMERA_SIM_HOST to be set.
 *
 * Covers:
 *  - controlPlaneHost(): resolves hostname from CAMERA_SIM_CONTROL_URL.
 *  - camsimHealth(): GET /health happy path.
 *  - camsimListCameras(): GET /cameras happy path.
 *  - camsimAddCamera(): POST /cameras happy path, HTTP error, network failure.
 *  - camsimDeleteCamera(): DELETE /cameras/:name happy path, name encoding.
 *  - camsimBulkReplace(): POST /cameras/bulk, verifies body shape.
 *  - camsimUploadFile(): PUT /files/:name, verifies binary body + headers.
 *  - camsimDeleteFile(): DELETE /files/:name happy path.
 *  - CamsimControlError thrown for HTTP errors and network failures.
 *  - controlBaseUrl throws when neither env var is set.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Module under test (imported before env stubs; env is read at call time) ─

import {
  camsimHealth,
  camsimListCameras,
  camsimAddCamera,
  camsimDeleteCamera,
  camsimBulkReplace,
  camsimUploadFile,
  camsimDeleteFile,
  controlPlaneHost,
  CamsimControlError,
} from "@/lib/helpers/camsim-control";

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE = "http://camera-sim-test:8080";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errResponse(
  status: number,
  body: { error?: string; hint?: string } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("CAMERA_SIM_CONTROL_URL", BASE);
  // Ensure CAMERA_SIM_HOST placeholder doesn't leak through.
  vi.stubEnv("CAMERA_SIM_HOST", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ═════════════════════════════════════════════════════════════════════════════
// controlPlaneHost
// ═════════════════════════════════════════════════════════════════════════════

describe("controlPlaneHost", () => {
  it("extracts hostname from CAMERA_SIM_CONTROL_URL", () => {
    const host = controlPlaneHost();
    expect(host).toBe("camera-sim-test");
  });

  it("falls back to CAMERA_SIM_HOST when CAMERA_SIM_CONTROL_URL is unset", () => {
    vi.stubEnv("CAMERA_SIM_CONTROL_URL", "");
    vi.stubEnv("CAMERA_SIM_HOST", "1.2.3.4");

    const host = controlPlaneHost();
    expect(host).toBe("1.2.3.4");
  });

  it("throws CamsimControlError when neither env var is configured", () => {
    vi.stubEnv("CAMERA_SIM_CONTROL_URL", "");
    vi.stubEnv("CAMERA_SIM_HOST", "");

    expect(() => controlPlaneHost()).toThrow(CamsimControlError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// camsimHealth
// ═════════════════════════════════════════════════════════════════════════════

describe("camsimHealth", () => {
  it("GET /health: returns ok + version from the control-plane", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ ok: true, version: "1.2.3" })
    );

    const result = await camsimHealth();

    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.2.3");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${BASE}/health`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// camsimListCameras
// ═════════════════════════════════════════════════════════════════════════════

describe("camsimListCameras", () => {
  it("GET /cameras: unwraps cameras array from response", async () => {
    const cameras = [
      { name: "cam1", source: "rtsp://host/1", staged: false },
      { name: "cam2", source: "rtsp://host/2", staged: true },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({ cameras }));

    const result = await camsimListCameras();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("cam1");
    expect(result[1].staged).toBe(true);

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${BASE}/cameras`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// camsimAddCamera
// ═════════════════════════════════════════════════════════════════════════════

describe("camsimAddCamera", () => {
  it("POST /cameras: sends correct JSON body, returns camera + restart", async () => {
    const responseBody = {
      camera: { name: "cam1", source: "rtsp://host/1", staged: false },
      restart: { ok: true, output: "restarted" },
    };
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(responseBody));

    const result = await camsimAddCamera({
      name: "cam1",
      source: "rtsp://host/1",
      description: "Main entrance",
    });

    expect(result.camera.name).toBe("cam1");
    expect(result.restart.ok).toBe(true);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE}/cameras`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });

    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("cam1");
    expect(body.source).toBe("rtsp://host/1");
    expect(body.description).toBe("Main entrance");
  });

  it("HTTP 4xx: throws CamsimControlError with the status code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errResponse(422, { error: "validation failed", hint: "check source URL" })
    );

    const err = await camsimAddCamera({ name: "bad", source: "not-a-url" }).catch(
      (e) => e
    );

    expect(err).toBeInstanceOf(CamsimControlError);
    expect(err.status).toBe(422);
  });

  it("network failure: throws CamsimControlError with status 502", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const err = await camsimAddCamera({ name: "cam1", source: "rtsp://x/1" }).catch(
      (e) => e
    );

    expect(err).toBeInstanceOf(CamsimControlError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/unreachable/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// camsimDeleteCamera
// ═════════════════════════════════════════════════════════════════════════════

describe("camsimDeleteCamera", () => {
  it("DELETE /cameras/:name: calls correct URL, returns deleted + remaining", async () => {
    const responseBody = {
      deleted: "cam1",
      remaining: 1,
      restart: { ok: true, output: "" },
    };
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(responseBody));

    const result = await camsimDeleteCamera("cam1");

    expect(result.deleted).toBe("cam1");
    expect(result.remaining).toBe(1);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE}/cameras/cam1`);
    expect(init.method).toBe("DELETE");
  });

  it("camera name is URL-encoded in the DELETE path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ deleted: "cam with spaces", remaining: 0, restart: { ok: true, output: "" } })
    );

    await camsimDeleteCamera("cam with spaces");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/\/cameras\/cam%20with%20spaces$/);
  });

  it("HTTP error: throws CamsimControlError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errResponse(404, { error: "camera not found" })
    );

    await expect(camsimDeleteCamera("nonexistent")).rejects.toThrow(
      CamsimControlError
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// camsimBulkReplace
// ═════════════════════════════════════════════════════════════════════════════

describe("camsimBulkReplace", () => {
  it("POST /cameras/bulk: sends cameras array wrapped in {cameras:[...]}", async () => {
    const cameras = [
      { name: "cam1", source: "rtsp://host/1" },
      { name: "cam2", source: "rtsp://host/2" },
    ];
    const responseBody = {
      cameras: cameras.map((c) => ({ ...c, staged: false })),
      added: ["cam1", "cam2"],
      removed: [],
      restart: { ok: true, output: "" },
    };
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(responseBody));

    const result = await camsimBulkReplace(cameras);

    expect(result.added).toEqual(["cam1", "cam2"]);
    expect(result.removed).toEqual([]);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE}/cameras/bulk`);
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    // The payload must be wrapped: { cameras: [...] }
    expect(body).toHaveProperty("cameras");
    expect(body.cameras).toHaveLength(2);
    expect(body.cameras[0].name).toBe("cam1");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// camsimUploadFile
// ═════════════════════════════════════════════════════════════════════════════

describe("camsimUploadFile", () => {
  it("PUT /files/:name: sends binary buffer with octet-stream content-type", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ name: "clip.ts", size: 42 })
    );

    const buf = Buffer.from("fake-video-data");
    const result = await camsimUploadFile("clip.ts", buf);

    expect(result.name).toBe("clip.ts");
    expect(result.size).toBe(42);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE}/files/clip.ts`);
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
    });
    // Body should be a Uint8Array view of the input buffer.
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it("filename is URL-encoded in the PUT path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ name: "my clip.ts", size: 10 })
    );

    await camsimUploadFile("my clip.ts", Buffer.from("x"));

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/\/files\/my%20clip\.ts$/);
  });

  it("network failure: throws CamsimControlError with status 502", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const err = await camsimUploadFile("clip.ts", Buffer.from("x")).catch(
      (e) => e
    );

    expect(err).toBeInstanceOf(CamsimControlError);
    expect(err.status).toBe(502);
  });

  it("HTTP error: throws CamsimControlError with response status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("too large", { status: 413 })
    );

    const err = await camsimUploadFile("big.ts", Buffer.from("x")).catch(
      (e) => e
    );

    expect(err).toBeInstanceOf(CamsimControlError);
    expect(err.status).toBe(413);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// camsimDeleteFile
// ═════════════════════════════════════════════════════════════════════════════

describe("camsimDeleteFile", () => {
  it("DELETE /files/:name: calls correct URL with DELETE method", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({}));

    await camsimDeleteFile("clip.ts");

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE}/files/clip.ts`);
    expect(init.method).toBe("DELETE");
  });

  it("HTTP error: throws CamsimControlError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errResponse(404, { error: "file not found" })
    );

    await expect(camsimDeleteFile("missing.ts")).rejects.toThrow(
      CamsimControlError
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CamsimControlError — unconfigured host
// ═════════════════════════════════════════════════════════════════════════════

describe("unconfigured control-plane host", () => {
  it("any call throws CamsimControlError (503) when CAMERA_SIM_HOST holds placeholder", async () => {
    vi.stubEnv("CAMERA_SIM_CONTROL_URL", "");
    vi.stubEnv("CAMERA_SIM_HOST", "<camera-sim-public-ip>");

    const err = await camsimHealth().catch((e) => e);

    expect(err).toBeInstanceOf(CamsimControlError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/CAMERA_SIM_HOST/);
  });
});
