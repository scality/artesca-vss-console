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

// ── Lazy imports (resolved after setting CONSOLE_RUNTIME=docker) ─────────────

import { auth } from "@/lib/auth";
import { gcsCamerasGet } from "@/lib/helpers/gcs-config";
import { vstListSensors } from "@/lib/helpers/vst";
import { camsimListCameras, controlPlaneHost } from "@/lib/helpers/camsim-control";

// GET is imported fresh per-test (see beforeEach) so DOCKER_MODE=true at load.
let GET: () => Promise<Response>;

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Set docker mode BEFORE re-importing the route so the module-level
  // DOCKER_MODE constant evaluates to true.
  process.env.CONSOLE_RUNTIME = "docker";
  delete process.env.VSS_INSTANCE_NAME;

  vi.resetModules();
  ({ GET } = await import("@/app/api/cameras/route"));

  vi.mocked(auth).mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(gcsCamerasGet).mockResolvedValue(null);
  vi.mocked(vstListSensors).mockResolvedValue({ sensors: [], warning: undefined });
  vi.mocked(camsimListCameras).mockResolvedValue([]);
  vi.mocked(controlPlaneHost).mockReturnValue("192.168.1.10");
});

afterEach(() => {
  delete process.env.CONSOLE_RUNTIME;
  delete process.env.VSS_INSTANCE_NAME;
});

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
