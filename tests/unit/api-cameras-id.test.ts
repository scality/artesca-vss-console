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
import { vstDeleteSensor } from "@/lib/helpers/vst";
import { getCameraOverride, upsertCameraOverride, deleteCameraOverride } from "@/lib/db";
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
  vi.mocked(getCameraOverride).mockReset().mockReturnValue(null);
  vi.mocked(deleteCameraOverride).mockReset();
  vi.mocked(writeToGcs).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  delete process.env.VSS_INSTANCE_NAME;
  delete process.env.CONSOLE_RUNTIME;
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/cameras/[id]", () => {
  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("GET");
    const res = await GET(req, makeParams("cam01"));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("happy path: returns cameraId + override from DB", async () => {
    vi.mocked(getCameraOverride).mockReturnValue({
      cameraId: "cam01",
      scenarioIds: ["s1"],
      recordingEnabled: true,
      recordingPolicy: "always",
      recordingRetentionDays: 7,
      updatedAt: "2024-01-01T00:00:00Z",
      updatedBy: "operator@test.com",
    });

    const req = makeRequest("GET");
    const res = await GET(req, makeParams("cam01"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cameraId).toBe("cam01");
    expect(body.override).toBeDefined();
    expect(body.override.scenarioIds).toEqual(["s1"]);
  });

  it("unknown id: no override found → returns cameraId with null override", async () => {
    vi.mocked(getCameraOverride).mockReturnValue(null);

    const req = makeRequest("GET");
    const res = await GET(req, makeParams("unknown-cam"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cameraId).toBe("unknown-cam");
    expect(body.override).toBeNull();
  });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/cameras/[id]", () => {
  beforeEach(() => {
    process.env.CONSOLE_RUNTIME = "docker";
  });

  it("auth missing → 401, no camsim calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("PATCH", { description: "Updated" });
    const res = await PATCH(req, makeParams("cam01"));

    expect(res.status).toBe(401);
    expect(camsimListCameras).not.toHaveBeenCalled();
    expect(camsimDeleteCamera).not.toHaveBeenCalled();
    expect(camsimAddCamera).not.toHaveBeenCalled();
  });

  it("invalid body (zod): feeds array is empty (min 1 check) → 400", async () => {
    const req = makeRequest("PATCH", { feeds: [] });
    const res = await PATCH(req, makeParams("cam01"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(camsimListCameras).not.toHaveBeenCalled();
  });

  it("camera not found on camera-sim → 404", async () => {
    vi.mocked(camsimListCameras).mockResolvedValue([]); // cam01 not in list

    const req = makeRequest("PATCH", { description: "Updated" });
    const res = await PATCH(req, makeParams("cam01"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
    expect(camsimDeleteCamera).not.toHaveBeenCalled();
  });

  it("PATCH happy path: description update → delete + re-add with new description, audit logged", async () => {
    const req = makeRequest("PATCH", { description: "Updated entrance" });
    const res = await PATCH(req, makeParams("cam01"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cameraId).toBe("cam01");

    expect(camsimDeleteCamera).toHaveBeenCalledWith("cam01");
    expect(camsimAddCamera).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cam01", description: "Updated entrance" }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "camera-update",
      "camera/cam01",
      expect.any(Object),
    );
  });

  it.todo(
    "PATCH with fileBase64: uploads file to camsim before delete+re-add — testing file upload flow requires Buffer assertions and is covered by camsim-control.test.ts",
  );
});

// ── PATCH (k8s) ───────────────────────────────────────────────────────────────

describe("PATCH /api/cameras/[id] (k8s)", () => {
  it("re-adds on camsim then upserts the updated entry to Firestore + applies", async () => {
    delete process.env.CONSOLE_RUNTIME;
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

describe("PUT /api/cameras/[id] overrides (docker)", () => {
  beforeEach(() => {
    process.env.CONSOLE_RUNTIME = "docker";
  });

  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("PUT", { scenarioIds: ["fall"] });
    const res = await PUT(req, makeParams("cam01"));

    expect(res.status).toBe(401);
  });

  it("invalid body → 400", async () => {
    const req = makeRequest("PUT", { scenarioIds: "not-an-array" });
    const res = await PUT(req, makeParams("cam01"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/validation/i);
  });

  it("both fields absent/null → clears override (deleteCameraOverride), audit logged", async () => {
    const req = makeRequest("PUT", {});
    const res = await PUT(req, makeParams("cam01"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(true);
    expect(deleteCameraOverride).toHaveBeenCalledWith("cam01");
    expect(upsertCameraOverride).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith("camera-override-clear", "camera/cam01", {});
  });

  it("upserts override into SQLite when scenarioIds provided", async () => {
    const req = makeRequest("PUT", { scenarioIds: ["fall", "fire"], recording: { enabled: true, policy: "always", retentionDays: 7 } });
    const res = await PUT(req, makeParams("cam01"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(upsertCameraOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        cameraId: "cam01",
        scenarioIds: ["fall", "fire"],
        recordingEnabled: true,
        recordingPolicy: "always",
        recordingRetentionDays: 7,
        updatedBy: "operator@test.com",
      }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "camera-override-update",
      "camera/cam01",
      expect.any(Object),
    );
  });
});

// ── PUT (k8s) ─────────────────────────────────────────────────────────────────

describe("PUT /api/cameras/[id] overrides (k8s)", () => {
  it("merges scenarioIds + recording into the Firestore camera doc", async () => {
    delete process.env.CONSOLE_RUNTIME;
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
});

// ── DELETE ────────────────────────────────────────────────────────────────────

describe("DELETE /api/cameras/[id]", () => {
  beforeEach(() => {
    process.env.CONSOLE_RUNTIME = "docker";
  });

  it("auth missing → 401, no camsim calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("DELETE");
    const res = await DELETE(req, makeParams("cam01"));

    expect(res.status).toBe(401);
    expect(camsimDeleteCamera).not.toHaveBeenCalled();
    expect(vstDeleteSensor).not.toHaveBeenCalled();
  });

  it("DELETE happy path: removes from camsim, unregisters from VST, removes from GCS, audit logged", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    const req = makeRequest("DELETE");
    const res = await DELETE(req, makeParams("cam01"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cameraId).toBe("cam01");

    // Step 1: camsim delete
    expect(camsimDeleteCamera).toHaveBeenCalledWith("cam01");
    // Step 2: VST unregister (best-effort)
    expect(vstDeleteSensor).toHaveBeenCalledWith("cam01");
    // Step 4: GCS remove (best-effort, VSS_INSTANCE_NAME set)
    expect(writeToGcs).toHaveBeenCalledWith(
      "cam01",
      null,
      expect.any(String),
      "remove",
    );
    // Audit logged
    expect(auditLog).toHaveBeenCalledWith(
      "camera-delete",
      "camera/cam01",
      expect.objectContaining({ cameraId: "cam01" }),
    );
  });

  it("DELETE: camsim delete fails → returns error, VST + GCS not called", async () => {
    vi.mocked(camsimDeleteCamera).mockRejectedValueOnce(
      new CamsimControlError("camera not found", 404),
    );

    const req = makeRequest("DELETE");
    const res = await DELETE(req, makeParams("cam01"));

    // camsimDeleteCamera threw — route returns that error
    expect([404, 502]).toContain(res.status);
    const body = await res.json();
    expect(body.error).toBeDefined();
    // VST and GCS must NOT be called when camsim fails
    expect(vstDeleteSensor).not.toHaveBeenCalled();
    expect(writeToGcs).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("DELETE rollback: VST delete fails after camsim succeeds → camsim NOT rolled back, warning in response, audit still logged", async () => {
    vi.mocked(vstDeleteSensor).mockResolvedValueOnce({
      ok: false,
      warning: "VST delete returned HTTP 500",
    });

    const req = makeRequest("DELETE");
    const res = await DELETE(req, makeParams("cam01"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Warning surfaced — VST is best-effort
    expect(body.warnings).toEqual(expect.arrayContaining([expect.stringContaining("VST")]));

    // camsim was NOT called again to undo the delete
    expect(camsimDeleteCamera).toHaveBeenCalledTimes(1);
    // Audit is still logged (delete did complete from camsim's perspective)
    expect(auditLog).toHaveBeenCalledWith("camera-delete", "camera/cam01", expect.any(Object));
  });

  it("DELETE: VSS_INSTANCE_NAME not set → GCS write skipped, no gcsWarning in response", async () => {
    delete process.env.VSS_INSTANCE_NAME;

    const req = makeRequest("DELETE");
    const res = await DELETE(req, makeParams("cam01"));

    expect(res.status).toBe(200);
    // GCS write should not be called when instance name is absent
    expect(writeToGcs).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.warnings).toEqual([]);
  });

  it.todo(
    "DELETE: camsimDeleteFile throws a non-404 error → warning appended to warnings[] — file deletion is step 3 (best-effort); the response is still 200",
  );
});

// ── DELETE (k8s) ──────────────────────────────────────────────────────────────

describe("DELETE /api/cameras/[id] (k8s)", () => {
  it("deletes from Firestore + unregisters VST, does not call writeToGcs", async () => {
    delete process.env.CONSOLE_RUNTIME;
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
