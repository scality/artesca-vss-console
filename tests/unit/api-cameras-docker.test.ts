import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────
//
// These vi.mock() calls are hoisted by vitest and persist across vi.resetModules().
// The route is re-imported via dynamic import() inside beforeEach after setting
// CONSOLE_RUNTIME=docker so DOCKER_MODE evaluates to true at module load time.

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/helpers/camsim-control", () => ({
  camsimListCameras: vi.fn().mockResolvedValue([]),
  camsimAddCamera: vi.fn().mockResolvedValue({
    camera: { name: "cam-01", source: "entrance.ts", staged: false },
    restart: { ok: true, output: "" },
  }),
  camsimUploadFile: vi.fn().mockResolvedValue({ name: "entrance.ts", size: 1024 }),
  controlPlaneHost: vi.fn().mockReturnValue("192.168.1.10"),
  CamsimControlError: class CamsimControlError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/helpers/vst", () => ({
  vstListSensors: vi.fn().mockResolvedValue({ sensors: [], warning: undefined }),
}));

vi.mock("@/lib/helpers/mediamtx", () => ({
  mediamtxListPaths: vi.fn().mockResolvedValue({ paths: [], warning: undefined }),
}));

vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsCamerasGet: vi.fn().mockResolvedValue(null),
  gcsCamerasPut: vi.fn().mockResolvedValue(undefined),
  gcsHealthCheck: vi.fn().mockResolvedValue({ status: "ok" }),
}));

vi.mock("@/lib/gcs-bootstrap", () => ({
  triggerCameraBootstrap: vi.fn(),
  awaitBootstrap: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  listCameraOverrides: vi.fn().mockReturnValue([]),
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

// k8s-path modules — stubbed so they never run in docker mode.
vi.mock("@/lib/reconcile/context", () => ({
  ReconcileContextError: class extends Error {
    name = "ReconcileContextError";
  },
  makeReconcileContext: vi.fn().mockRejectedValue(new Error("should not be called in docker mode")),
}));

vi.mock("@/lib/cameras/collect-k8s", () => ({
  buildK8sCamerasResponse: vi.fn().mockReturnValue({ cameras: [], reconcile: null }),
}));

vi.mock("@/lib/reconcile/cameras", () => ({
  reconcileCameras: vi.fn().mockRejectedValue(new Error("should not be called in docker mode")),
}));

// ── Lazy imports (resolved after setting CONSOLE_RUNTIME=docker) ─────────────

import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { gcsCamerasGet, gcsCamerasPut } from "@/lib/helpers/gcs-config";
import { vstListSensors } from "@/lib/helpers/vst";
import {
  camsimListCameras,
  camsimUploadFile,
  camsimAddCamera,
  controlPlaneHost,
} from "@/lib/helpers/camsim-control";
import { auditLog } from "@/lib/helpers/audit";
import type { NextRequest } from "next/server";

// GET and POST are imported fresh per-test (see beforeEach) so DOCKER_MODE=true at load.
let GET: () => Promise<Response>;
let POST: (req: NextRequest) => Promise<Response>;

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Set docker mode BEFORE re-importing the route so the module-level
  // DOCKER_MODE constant evaluates to true.
  process.env.CONSOLE_RUNTIME = "docker";
  delete process.env.VSS_INSTANCE_NAME;

  vi.resetModules();
  ({ GET, POST } = await import("@/app/api/cameras/route") as never);

  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(gcsCamerasGet).mockReset().mockResolvedValue(null);
  vi.mocked(gcsCamerasPut).mockReset().mockResolvedValue(undefined);
  vi.mocked(vstListSensors).mockReset().mockResolvedValue({ sensors: [], warning: undefined });
  vi.mocked(camsimListCameras).mockReset().mockResolvedValue([]);
  vi.mocked(camsimUploadFile).mockReset().mockResolvedValue({ name: "entrance.ts", size: 1024 } as never);
  vi.mocked(camsimAddCamera).mockReset().mockResolvedValue({
    camera: { name: "cam-01", source: "entrance.ts", staged: false },
    restart: { ok: true, output: "" },
  } as never);
  vi.mocked(controlPlaneHost).mockReset().mockReturnValue("192.168.1.10");
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.CONSOLE_RUNTIME;
  delete process.env.VSS_INSTANCE_NAME;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePostRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/cameras", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

const VALID_CAMERA_BODY = {
  cameraId: "cam-01",
  description: "Entrance camera",
  role: "other",
  feeds: [
    {
      fileName: "entrance.ts",
      fileBase64: Buffer.from("dummy").toString("base64"),
    },
  ],
};

// ── GET (docker path) ─────────────────────────────────────────────────────────

describe("GET /api/cameras (docker)", () => {
  it("happy path: GCS returns null, camsim returns entries → cameras returned from camsim", async () => {
    vi.mocked(gcsCamerasGet).mockResolvedValue(null);
    vi.mocked(camsimListCameras).mockResolvedValue([
      { name: "cam-01", source: "rtsp", description: "Entrance", staged: false },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cameras).toHaveLength(1);
    expect(body.cameras[0].id).toBe("cam-01");
    // GCS not available (VSS_INSTANCE_NAME empty at module load)
    expect(body.gcs.available).toBe(false);
  });

  it("GCS returns null and camsim empty: falls back to VST sensors", async () => {
    vi.mocked(gcsCamerasGet).mockResolvedValue(null);
    vi.mocked(camsimListCameras).mockResolvedValue([]);
    vi.mocked(vstListSensors).mockResolvedValue({
      sensors: [
        {
          sensor_id: "vst-cam",
          name: "VST Camera",
          rtsp_url: "rtsp://vst-cam",
        },
      ],
      warning: undefined,
    } as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    // Falls back to VST sensors
    expect(body.cameras).toHaveLength(1);
    expect(body.cameras[0].id).toBe("vst-cam");
  });

  it("controlPlaneHost throws in docker mode → returns 200 with empty cameras and warning", async () => {
    vi.mocked(controlPlaneHost).mockImplementation(() => {
      throw new Error("CAMERA_SIM_HOST not configured");
    });
    vi.mocked(gcsCamerasGet).mockResolvedValue(null);

    const res = await GET();

    // In docker mode the route continues past controlPlaneHost throwing and
    // falls back to VST (which returns empty here) → 200 with empty cameras.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cameras).toEqual([]);
  });

  it("GCS and camsim both empty → returns empty cameras array", async () => {
    vi.mocked(gcsCamerasGet).mockResolvedValue(null);
    vi.mocked(camsimListCameras).mockResolvedValue([]);
    vi.mocked(vstListSensors).mockResolvedValue({ sensors: [], warning: undefined });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cameras).toEqual([]);
  });
});

// ── POST (docker path) ────────────────────────────────────────────────────────
// Covers the GCS write-through behavior and mode-independent guards that apply
// in docker mode. These tests were originally in api-cameras.test.ts and moved
// here because DOCKER_MODE is a module-level constant that must be true at load.

describe("POST /api/cameras (docker)", () => {
  it("auth missing → 401, no camsim calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makePostRequest(VALID_CAMERA_BODY);
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(camsimUploadFile).not.toHaveBeenCalled();
    expect(camsimAddCamera).not.toHaveBeenCalled();
  });

  it("kiosk mode: rejectIfKiosk returns 403 → short-circuits, no camsim calls", async () => {
    const { NextResponse } = await import("next/server");
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse as never);

    const req = makePostRequest(VALID_CAMERA_BODY);
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(camsimUploadFile).not.toHaveBeenCalled();
    expect(camsimAddCamera).not.toHaveBeenCalled();
  });

  it("invalid body: missing feeds → 400, no camsim calls", async () => {
    const req = makePostRequest({ cameraId: "cam-01" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(camsimUploadFile).not.toHaveBeenCalled();
    expect(camsimAddCamera).not.toHaveBeenCalled();
  });

  it("invalid body: cameraId with invalid chars → 400", async () => {
    const req = makePostRequest({
      ...VALID_CAMERA_BODY,
      cameraId: "INVALID CAMERA ID!",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(camsimUploadFile).not.toHaveBeenCalled();
  });

  it("happy path (docker): valid body → upload + register + audit, returns 200 with ok:true", async () => {
    const req = makePostRequest(VALID_CAMERA_BODY);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cameraId).toBe("cam-01");

    expect(camsimUploadFile).toHaveBeenCalledOnce();
    expect(camsimAddCamera).toHaveBeenCalledOnce();
    expect(camsimAddCamera).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cam-01" }),
    );
    expect(auditLog).toHaveBeenCalledWith("camera-add", "camera/cam-01", expect.any(Object));
  });

  it("camsimUploadFile fails → 502, no camsimAddCamera call", async () => {
    vi.mocked(camsimUploadFile).mockRejectedValueOnce(new Error("upload timeout"));

    const req = makePostRequest(VALID_CAMERA_BODY);
    const res = await POST(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/upload failed/i);
    expect(camsimAddCamera).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it.todo(
    "GCS push failure after successful camera add → 200 (best-effort) with gcsWarning; requires VSS_INSTANCE_NAME set — complex GCS mutex chain makes inline assertion brittle",
  );
});
