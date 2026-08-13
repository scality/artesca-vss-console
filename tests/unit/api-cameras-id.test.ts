import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

// cameras/[id] has no kiosk guard — PATCH + DELETE only check auth.

// The [id] route imports writeToGcs from its parent route.  Mock the whole
// parent route to avoid pulling in its transitive K8s / GCS dependencies.
vi.mock("@/app/api/cameras/route", () => ({
  writeToGcs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/vst", () => ({
  vstDeleteSensor: vi.fn().mockResolvedValue({ ok: true }),
  setRecording: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/helpers/camsim-control", () => ({
  camsimListCameras: vi.fn().mockResolvedValue([]),
  camsimAddCamera: vi.fn().mockResolvedValue({
    camera: { name: "cam01", source: "entrance.ts", staged: false },
    restart: { ok: true, output: "" },
  }),
  camsimDeleteCamera: vi.fn().mockResolvedValue({
    deleted: "cam01",
    remaining: 0,
    restart: { ok: true, output: "" },
  }),
  camsimUploadFile: vi.fn().mockResolvedValue({ name: "entrance.ts", size: 1024 }),
  camsimDeleteFile: vi.fn().mockResolvedValue(undefined),
  CamsimControlError: class CamsimControlError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "CamsimControlError";
      this.status = status;
    }
  },
}));

vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsCamerasGet: vi.fn().mockResolvedValue(null),
  gcsCamerasPut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  getCameraOverride: vi.fn().mockReturnValue(null),
  upsertCameraOverride: vi.fn(),
  deleteCameraOverride: vi.fn(),
  listCameraOverrides: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/reconcile/context", () => ({
  ReconcileContextError: class extends Error {},
  makeReconcileContext: vi.fn(),
}));

vi.mock("@/lib/reconcile/cameras", () => ({
  reconcileCameras: vi.fn().mockResolvedValue({ added: [], alreadyPresent: ["cam01"], failed: [], pruned: [], drift: [] }),
}));

import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import {
  camsimListCameras,
  camsimDeleteCamera,
  camsimAddCamera,
  camsimDeleteFile,
  CamsimControlError,
} from "@/lib/helpers/camsim-control";
import { vstDeleteSensor, setRecording } from "@/lib/helpers/vst";
import { getCameraOverride, upsertCameraOverride, deleteCameraOverride } from "@/lib/db";
import { gcsCamerasGet } from "@/lib/helpers/gcs-config";
import { auditLog } from "@/lib/helpers/audit";
import { writeToGcs } from "@/app/api/cameras/route";
import { makeReconcileContext } from "@/lib/reconcile/context";

import { GET, PUT, PATCH, DELETE } from "@/app/api/cameras/[id]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(method: string, body?: unknown): NextRequest {
  return new Request(`http://localhost/api/cameras/${body ? "cam01" : "cam01"}`, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  }) as unknown as NextRequest;
}

const MOCK_CAMERA = {
  name: "cam01",
  source: "entrance.ts",
  description: "Entrance camera",
  staged: false,
};

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(camsimListCameras).mockReset().mockResolvedValue([MOCK_CAMERA]);
  vi.mocked(camsimDeleteCamera).mockReset().mockResolvedValue({
    deleted: "cam01",
    remaining: 0,
    restart: { ok: true, output: "" },
  });
  vi.mocked(camsimAddCamera).mockReset().mockResolvedValue({
    camera: MOCK_CAMERA,
    restart: { ok: true, output: "" },
  });
  vi.mocked(camsimDeleteFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(vstDeleteSensor).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(setRecording).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(gcsCamerasGet).mockReset().mockResolvedValue(null);
  vi.mocked(getCameraOverride).mockReset().mockReturnValue(null);
  vi.mocked(deleteCameraOverride).mockReset();
  vi.mocked(writeToGcs).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  delete process.env.VSS_INSTANCE_NAME;
});

// ── GET ──────────────────────────────────────────────────────────────────────

// ── GET (k8s) ─────────────────────────────────────────────────────────────────

describe("GET /api/cameras/[id] (k8s)", () => {
  it("reads override from Firestore camera doc, not SQLite", async () => {
    const readCameras = vi.fn().mockResolvedValue([
      {
        id: "cam01",
        rtspUrl: "rtsp://x/cam01",
        scenarioIds: ["fall"],
        recording: { enabled: true, policy: "always", retentionDays: 7 },
      },
    ]);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1",
      adapter: {} as never,
      refs: {} as never,
      store: { readCameras } as never,
    } as never);

    const req = makeRequest("GET");
    const res = await GET(req, makeParams("cam01"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cameraId).toBe("cam01");
    expect(body.override).toBeDefined();
    expect(body.override.scenarioIds).toEqual(["fall"]);
    expect(body.override.recordingPolicy).toBe("always");
    // SQLite must not be called on k8s path
    expect(getCameraOverride).not.toHaveBeenCalled();
  });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

// ── PATCH (k8s) ───────────────────────────────────────────────────────────────

describe("PATCH /api/cameras/[id] (k8s)", () => {
  it("re-adds on camsim then upserts the updated entry to Firestore + applies", async () => {
    const upsertCamera = vi.fn().mockResolvedValue(undefined);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: {} as never, store: { upsertCamera, readCameras: vi.fn().mockResolvedValue([]) } as never,
    } as never);
    vi.mocked(camsimListCameras).mockResolvedValue([{ name: "cam01", source: "entrance.ts", description: "Entrance", staged: false }]);
    const req = makeRequest("PATCH", { description: "Updated entrance" });
    const res = await PATCH(req, makeParams("cam01"));
    expect(res.status).toBe(200);
    expect(camsimDeleteCamera).toHaveBeenCalledWith("cam01");
    expect(camsimAddCamera).toHaveBeenCalled();
    expect(upsertCamera).toHaveBeenCalledWith("inst-1", expect.objectContaining({ id: "cam01", description: "Updated entrance" }), expect.any(String));
  });
});

// ── PUT (docker) ─────────────────────────────────────────────────────────────

// ── PUT (k8s) ─────────────────────────────────────────────────────────────────

// ── DELETE ────────────────────────────────────────────────────────────────────

// ── DELETE (k8s) ──────────────────────────────────────────────────────────────

describe("PUT /api/cameras/[id] overrides (k8s)", () => {
  it("merges scenarioIds + recording into the Firestore camera doc", async () => {
    const upsertCamera = vi.fn().mockResolvedValue(undefined);
    const readCameras = vi.fn().mockResolvedValue([{ id: "cam01", rtspUrl: "rtsp://x/cam01", description: "Entrance" }]);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: {} as never, store: { upsertCamera, readCameras } as never,
    } as never);
    const req = makeRequest("PUT", { scenarioIds: ["fall"], recording: { enabled: true, policy: "always", retentionDays: 7 } });
    const res = await PUT(req, makeParams("cam01"));
    expect(res.status).toBe(200);
    expect(upsertCamera).toHaveBeenCalledWith(
      "inst-1",
      expect.objectContaining({
        id: "cam01", rtspUrl: "rtsp://x/cam01",
        scenarioIds: ["fall"],
        recording: { enabled: true, policy: "always", retentionDays: 7 },
      }),
      expect.any(String),
    );
  });

  it("recording.enabled=false → calls setRecording with the camera doc rtspUrl", async () => {
    const upsertCamera = vi.fn().mockResolvedValue(undefined);
    const readCameras = vi.fn().mockResolvedValue([{ id: "cam01", rtspUrl: "rtsp://x/cam01", description: "Entrance" }]);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: {} as never, store: { upsertCamera, readCameras } as never,
    } as never);
    const req = makeRequest("PUT", { recording: { enabled: false, policy: "off", retentionDays: 7 } });
    const res = await PUT(req, makeParams("cam01"));
    expect(res.status).toBe(200);
    expect(setRecording).toHaveBeenCalledWith("cam01", false, "rtsp://x/cam01");
  });
});

describe("DELETE /api/cameras/[id] (k8s)", () => {
  it("deletes from Firestore + unregisters VST, does not call writeToGcs", async () => {
    const deleteCamera = vi.fn().mockResolvedValue(undefined);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: {} as never, store: { deleteCamera } as never,
    } as never);
    const req = makeRequest("DELETE");
    const res = await DELETE(req, makeParams("cam01"));
    expect(res.status).toBe(200);
    expect(deleteCamera).toHaveBeenCalledWith("inst-1", "cam01", expect.any(String));
    expect(vstDeleteSensor).toHaveBeenCalledWith("cam01");
    expect(writeToGcs).not.toHaveBeenCalled();
  });
});
