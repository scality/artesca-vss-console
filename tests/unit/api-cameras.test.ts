import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

// The cameras GET route does NOT use K8s ConfigMaps — it uses camsim control
// and GCS as the authoritative source. Mock the actual camera-specific helpers.
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

// k8s path mocks — needed so the k8s branch resolves when CONSOLE_RUNTIME is not "docker"
vi.mock("@/lib/reconcile/context", () => ({
  ReconcileContextError: class extends Error {
    name = "ReconcileContextError";
  },
  makeReconcileContext: vi.fn(),
}));

vi.mock("@/lib/cameras/collect-k8s", () => ({
  buildK8sCamerasResponse: vi.fn().mockReturnValue({ cameras: [], reconcile: null }),
}));

vi.mock("@/lib/reconcile/cameras", () => ({
  reconcileCameras: vi.fn().mockResolvedValue({
    added: ["cam-01"],
    alreadyPresent: [],
    failed: [],
    pruned: [],
    parked: [],
    drift: [],
  }),
}));

// The GET route's k8s branch also dynamically imports these helpers in its
// Promise.all — without mocks, listIngestingCameras() → listRealtimeRules()
// does a real fetch() with a 15s AbortSignal.timeout to the (unreachable in
// tests) in-cluster alert-bridge, which hangs well past vitest's 5s default
// timeout (the route's .catch() only handles rejection, not a slow-resolving
// promise). Mock all three so the k8s branch resolves instantly.
vi.mock("@/lib/helpers/ingestion", () => ({
  listIngestingCameras: vi.fn().mockResolvedValue({ ingesting: new Set(), warning: undefined }),
}));

vi.mock("@/lib/helpers/recording-health", () => ({
  probeRecordingByName: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/reconcile/recording-recovery", () => ({
  getRecoveryStates: vi.fn().mockReturnValue(new Map()),
}));

import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { gcsCamerasGet, gcsCamerasPut } from "@/lib/helpers/gcs-config";
import { vstListSensors } from "@/lib/helpers/vst";
import { camsimListCameras, camsimUploadFile, camsimAddCamera, controlPlaneHost } from "@/lib/helpers/camsim-control";
import { auditLog } from "@/lib/helpers/audit";
import { makeReconcileContext } from "@/lib/reconcile/context";
import { buildK8sCamerasResponse } from "@/lib/cameras/collect-k8s";
import { reconcileCameras } from "@/lib/reconcile/cameras";

import { GET, POST } from "@/app/api/cameras/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(gcsCamerasGet).mockReset().mockResolvedValue(null);
  vi.mocked(gcsCamerasPut).mockReset().mockResolvedValue(undefined);
  vi.mocked(vstListSensors).mockReset().mockResolvedValue({ sensors: [], warning: undefined });
  vi.mocked(camsimListCameras).mockReset().mockResolvedValue([]);
  vi.mocked(camsimUploadFile).mockReset().mockResolvedValue({ name: "entrance.ts", size: 1024 });
  vi.mocked(camsimAddCamera).mockReset().mockResolvedValue({
    camera: { name: "cam-01", source: "entrance.ts", staged: false },
    restart: { ok: true, output: "" },
  });
  vi.mocked(controlPlaneHost).mockReset().mockReturnValue("192.168.1.10");
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);
  // Default k8s path mocks
  vi.mocked(makeReconcileContext).mockReset().mockResolvedValue({
    instance: "inst-1",
    adapter: {} as never,
    refs: {} as never,
    store: {
      readCameras: vi.fn().mockResolvedValue([]),
      readStatus: vi.fn().mockResolvedValue(null),
      upsertCamera: vi.fn().mockResolvedValue(undefined),
    } as never,
  } as never);
  vi.mocked(reconcileCameras).mockReset().mockResolvedValue({
    added: ["cam-01"],
    alreadyPresent: [],
    failed: [],
    pruned: [],
    parked: [],
    drift: [],
  });
  vi.mocked(buildK8sCamerasResponse).mockReset().mockReturnValue({ cameras: [], reconcile: null });
  // Ensure no VSS_INSTANCE_NAME so GCS writes are skipped in most tests
  delete process.env.VSS_INSTANCE_NAME;
  delete process.env.CONSOLE_RUNTIME;
});

// ── GET (k8s path) ────────────────────────────────────────────────────────────

describe("GET /api/cameras (k8s)", () => {
  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  // NOTE: buildK8sCamerasResponse (the function that actually computes
  // vstRegistered from the merge of desired + live VST sensors) is mocked
  // below, so the vstRegistered assertion here is mock-passthrough, not a
  // test of the real merge logic — that's covered by
  // tests/unit/cameras-collect-k8s.test.ts. This test instead exercises what
  // the GET route itself owns: wiring the k8s helpers together and shaping
  // the response (no warnings surfaced when every helper is happy).
  it("returns Firestore desired cameras with live vstRegistered", async () => {
    vi.mocked(vstListSensors).mockResolvedValue({
      sensors: [{ sensor_id: "aisle-1", name: "aisle-1" }],
      warning: undefined,
    } as never);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: {} as never,
      store: {
        readCameras: vi.fn().mockResolvedValue([{ id: "aisle-1", rtspUrl: "rtsp://x/aisle-1" }]),
        readStatus: vi.fn().mockResolvedValue(null),
      } as never,
    } as never);
    vi.mocked(buildK8sCamerasResponse).mockReturnValue({
      cameras: [
        {
          id: "aisle-1",
          role: "aisle",
          feeds: [{ id: "default", sensorId: "aisle-1", source: "rtsp", rtspUrl: "rtsp://x/aisle-1", vstRegistered: true, replayReady: false }],
          gcsPersisted: true,
        } as never,
      ],
      reconcile: null,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cameras).toHaveLength(1);
    expect(body.cameras[0].feeds[0].vstRegistered).toBe(true);
    expect(body.gcs.available).toBe(false);
    expect(body.warnings).toEqual([]);
  });

  it("degrades to empty list + warning when the context is unavailable", async () => {
    const { ReconcileContextError } = await import("@/lib/reconcile/context");
    vi.mocked(makeReconcileContext).mockRejectedValue(new ReconcileContextError("VSS_INSTANCE_NAME unset"));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cameras).toEqual([]);
    expect(body.warnings[0]).toMatch(/config store unavailable/);
  });
});

// Note: Docker-path GET tests (camsim/GCS-based) require DOCKER_MODE=true at module
// load time. Since DOCKER_MODE is a module-level constant, those tests need a
// separate vitest project with CONSOLE_RUNTIME=docker pre-set — out of scope here.

// ── POST (k8s path) ────────────────────────────────────────────────────────────
// Auth / validation / camsim-error tests are mode-independent; they live here
// because the k8s path is the default (CONSOLE_RUNTIME unset).
// Docker-mode POST tests (GCS write-through assertions) live in api-cameras-docker.test.ts.

describe("POST /api/cameras (k8s)", () => {
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
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

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

  it("uploads to camsim, upserts Firestore, and applies write-through", async () => {
    const upsertCamera = vi.fn().mockResolvedValue(undefined);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1",
      adapter: {} as never,
      refs: {} as never,
      store: {
        readCameras: vi.fn().mockResolvedValue([]),
        readStatus: vi.fn().mockResolvedValue(null),
        upsertCamera,
      } as never,
    } as never);

    const req = makePostRequest({
      cameraId: "cam01",
      role: "aisle",
      description: "Entrance",
      rtspUrl: "rtsp://1.2.3.4:8554/cam01",
      feeds: [{ fileName: "entrance.ts", fileBase64: Buffer.from("x").toString("base64") }],
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(camsimUploadFile).toHaveBeenCalled();
    expect(camsimAddCamera).toHaveBeenCalled();
    expect(upsertCamera).toHaveBeenCalledWith(
      "inst-1",
      expect.objectContaining({ id: "cam01", rtspUrl: "rtsp://1.2.3.4:8554/cam01" }),
      "operator@test.com",
    );
    expect(reconcileCameras).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith("camera-add", "camera/cam01", expect.any(Object));
  });

  it("Firestore upsert fails → warning in response, still 200", async () => {
    const { ReconcileContextError } = await import("@/lib/reconcile/context");
    vi.mocked(makeReconcileContext).mockRejectedValueOnce(
      new ReconcileContextError("Firestore init failed: project not set"),
    );

    const req = makePostRequest(VALID_CAMERA_BODY);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warnings).toContainEqual(expect.stringMatching(/config store write failed/));
    expect(camsimUploadFile).toHaveBeenCalled();
    expect(camsimAddCamera).toHaveBeenCalled();
  });
});
