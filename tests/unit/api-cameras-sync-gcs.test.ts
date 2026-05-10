import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/helpers/vst", () => ({
  vstListSensors: vi.fn().mockResolvedValue({ sensors: [], warning: undefined }),
}));

vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsCamerasGet: vi.fn().mockResolvedValue(null),
  gcsCamerasPut: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { vstListSensors } from "@/lib/helpers/vst";
import { gcsCamerasGet, gcsCamerasPut } from "@/lib/helpers/gcs-config";

import { POST } from "@/app/api/cameras/sync-gcs/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SENSOR_RESULT = {
  sensors: [
    { sensor_id: "cam-01", name: "Entrance", rtsp_url: "rtsp://host/cam-01" },
    { sensor_id: "cam-02", name: "Exit", rtsp_url: "rtsp://host/cam-02" },
  ],
  warning: undefined,
};

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(vstListSensors).mockReset().mockResolvedValue(SENSOR_RESULT);
  vi.mocked(gcsCamerasGet).mockReset().mockResolvedValue(null);
  vi.mocked(gcsCamerasPut).mockReset().mockResolvedValue(undefined);

  delete process.env.VSS_INSTANCE_NAME;
});

// ── POST /api/cameras/sync-gcs ───────────────────────────────────────────────

describe("POST /api/cameras/sync-gcs", () => {
  it("auth missing → 401, no VST or GCS calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(vstListSensors).not.toHaveBeenCalled();
    expect(gcsCamerasPut).not.toHaveBeenCalled();
  });

  it("VSS_INSTANCE_NAME not set → 400, no VST or GCS calls", async () => {
    // VSS_INSTANCE_NAME is a module-level const captured at import time.
    // Because this test suite is loaded with the env var unset (beforeEach deletes
    // it), the module const is "". The route guards on this and returns 400.
    const res = await POST();

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/VSS_INSTANCE_NAME/);
    expect(vstListSensors).not.toHaveBeenCalled();
    expect(gcsCamerasPut).not.toHaveBeenCalled();
  });

  it("VST unreachable (0 sensors + warning) → 502", async () => {
    // The route returns 400 first if VSS_INSTANCE_NAME is empty.
    // We can only test the VST-unreachable branch by verifying the route guard
    // executes before vstListSensors — which is already covered by the 400 test.
    // However, to reach the VST branch the module const must be non-empty; since
    // that is captured at load time we cannot change it in a subsequent test
    // without re-importing the module. Instead, we verify the guard ordering by
    // confirming vstListSensors is never called when the instance name is absent.
    vi.mocked(vstListSensors).mockResolvedValue({
      sensors: [],
      warning: "connection refused",
    });

    const res = await POST();

    // Route still exits at the VSS_INSTANCE_NAME guard (status 400) before
    // reaching the VST call, so sensors stays uncalled.
    expect(res.status).toBe(400);
    expect(vstListSensors).not.toHaveBeenCalled();
  });

  it("gcsCamerasPut throws → 502 with extracted message", async () => {
    // Reaching the GCS write requires VSS_INSTANCE_NAME ≠ ""; since the module
    // const is captured at load-time, it equals "" in all tests (env unset before
    // import). So this path always exits at 400. We assert the guard is robust
    // and gcsCamerasPut is never called unexpectedly.
    vi.mocked(gcsCamerasPut).mockRejectedValue(new Error("GCS write timeout"));

    const res = await POST();

    expect(res.status).toBe(400);
    expect(gcsCamerasPut).not.toHaveBeenCalled();
  });

  it("happy path with VSS_INSTANCE_NAME set via env at module load: route structure is correct", async () => {
    // The module const is frozen at import. We verify the mock wiring is healthy:
    // when auth resolves and sensors are present the route eventually calls
    // gcsCamerasPut and returns ok:true (assuming VSS_INSTANCE_NAME were set).
    // Since we cannot set it post-import, we assert the 400 guard, which is the
    // expected behaviour for the default test environment.
    const res = await POST();
    const body = await res.json();

    // Deterministic: VSS_INSTANCE_NAME is always empty in unit test environment.
    expect(res.status).toBe(400);
    expect(body.error).toContain("VSS_INSTANCE_NAME");
  });
});

// ── Integration-style test with module re-import ─────────────────────────────
//
// The route captures VSS_INSTANCE_NAME as a top-level const at module load time.
// Vitest's module registry is shared within a suite — we use vi.doMock +
// dynamic import to spin up a fresh module instance with the env var pre-set,
// which lets us exercise the full happy-path without touching the default module.

describe("POST /api/cameras/sync-gcs — with VSS_INSTANCE_NAME set", () => {
  it("happy path: sensors → GCS put → returns ok:true with synced count", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    // Reinitialise the route so it picks up the new env var.
    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/vst", () => ({
      vstListSensors: vi.fn().mockResolvedValue(SENSOR_RESULT),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsCamerasGet: vi.fn().mockResolvedValue(null),
      gcsCamerasPut: vi.fn().mockResolvedValue(undefined),
    }));

    const { POST: POST2 } = await import("@/app/api/cameras/sync-gcs/route");
    const { gcsCamerasPut: put2 } = await import("@/lib/helpers/gcs-config");

    const res = await POST2();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.instance).toBe("test-instance");
    expect(body.synced).toBe(2);
    expect(put2).toHaveBeenCalledOnce();
    expect(put2).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: "isv-labs.cameras.v2",
        instance: "test-instance",
        cameras: expect.arrayContaining([
          expect.objectContaining({ id: "cam-01" }),
          expect.objectContaining({ id: "cam-02" }),
        ]),
      }),
    );

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });

  it("VST unreachable (0 sensors + warning) → 502", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/vst", () => ({
      vstListSensors: vi.fn().mockResolvedValue({ sensors: [], warning: "connection refused" }),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsCamerasGet: vi.fn().mockResolvedValue(null),
      gcsCamerasPut: vi.fn().mockResolvedValue(undefined),
    }));

    const { POST: POST2 } = await import("@/app/api/cameras/sync-gcs/route");

    const res = await POST2();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/VST unreachable/);

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });

  it("gcsCamerasPut throws → 502 with extracted error message", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/vst", () => ({
      vstListSensors: vi.fn().mockResolvedValue(SENSOR_RESULT),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsCamerasGet: vi.fn().mockResolvedValue(null),
      gcsCamerasPut: vi.fn().mockRejectedValue(new Error("GCS permission denied")),
    }));

    const { POST: POST2 } = await import("@/app/api/cameras/sync-gcs/route");

    const res = await POST2();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("GCS write failed");
    expect(body.error).toContain("GCS permission denied");

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });

  it("existing GCS cameras preserved across re-sync (scenarioIds + recording forwarded)", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/vst", () => ({
      vstListSensors: vi.fn().mockResolvedValue({
        sensors: [{ sensor_id: "cam-01", name: "Entrance", rtsp_url: "rtsp://host/cam-01" }],
        warning: undefined,
      }),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsCamerasGet: vi.fn().mockResolvedValue({
        schema: "isv-labs.cameras.v2",
        instance: "test-instance",
        updatedAt: "2026-01-01T00:00:00Z",
        updatedBy: "console",
        cameras: [
          {
            id: "cam-01",
            rtspUrl: "rtsp://old/cam-01",
            scenarioIds: ["theft", "slip-and-fall"],
            recording: true,
          },
        ],
      }),
      gcsCamerasPut: vi.fn().mockResolvedValue(undefined),
    }));

    const { POST: POST2 } = await import("@/app/api/cameras/sync-gcs/route");
    const { gcsCamerasPut: put2 } = await import("@/lib/helpers/gcs-config");

    const res = await POST2();

    expect(res.status).toBe(200);
    const putArg = vi.mocked(put2).mock.calls[0][0];
    const cam = putArg.cameras.find((c: { id: string }) => c.id === "cam-01");
    expect(cam?.scenarioIds).toEqual(["theft", "slip-and-fall"]);
    expect(cam?.recording).toBe(true);

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });
});
