import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({
    readNamespacedSecret: vi.fn(),
    patchNamespacedSecret: vi.fn(),
    replaceNamespacedSecret: vi.fn(),
  })),
  appsV1: vi.fn(() => ({
    patchNamespacedDeployment: vi.fn(),
  })),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
  MERGE_PATCH_OPTS: { middleware: [] },
}));

vi.mock("@/lib/errors", () => ({
  extractK8sError: vi.fn((err) => ({ status: 500, message: String(err) })),
}));

vi.mock("@/lib/db", () => ({
  saveProfile: vi.fn(),
  loadProfile: vi.fn(),
  listProfiles: vi.fn(() => []),
  appendAuditLog: vi.fn(),
  markRotated: vi.fn(),
  getRotationAge: vi.fn(() => null),
  // getDb is reset and configured per-test in beforeEach.
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ run: vi.fn().mockReturnValue({ changes: 1 }) })),
  })),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/configmaps", () => ({
  patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
  readConfigMapKey: vi.fn().mockResolvedValue({ value: "", resourceVersion: "1" }),
}));

vi.mock("@/lib/ssh", () => ({
  sshExec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
}));

vi.mock("@/lib/cluster-refs", () => {
  const RESTARTABLE: Record<string, { namespace: string; kind: string; name: string }> = {
    "rtvi-vlm": { namespace: "rtvi", kind: "Deployment", name: "rtvi-vlm" },
    "alert-worker": { namespace: "alerts", kind: "Deployment", name: "alert-worker" },
  };
  return {
    CLUSTER: {
      restartable: RESTARTABLE,
      demoData: { dockerContainer: "vss-demo-producer" },
      alertsTuning: { cooldownKey: "COOLDOWN_SECONDS", slackConfiguredKey: "SLACK_CONFIGURED" },
      rtvi: { nimMaxNumSeqsKey: "MAX_NUM_SEQS", nimKvCacheKey: "KV_CACHE_PERCENT", nimMaxModelLenKey: "MAX_MODEL_LEN" },
    },
    RESTARTABLE,
  };
});

vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn().mockResolvedValue(undefined),
  listComposeContainers: vi.fn().mockResolvedValue([]),
  DOCKER_TUNING_DIR: "/tmp/docker-tuning",
  inspectContainer: vi.fn().mockResolvedValue(null),
  runOneShotGpuContainer: vi.fn().mockResolvedValue(undefined),
  streamDockerLogs: vi.fn(),
  dockerRecreateWithEnv: vi.fn().mockResolvedValue(undefined),
  execInContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsScenariosPut: vi.fn().mockResolvedValue(undefined),
  gcsCamerasPut: vi.fn().mockResolvedValue(undefined),
  gcsPromptPut: vi.fn().mockResolvedValue(undefined),
}));

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { loadProfile, saveProfile, getDb } from "@/lib/db";
import { auditLog } from "@/lib/helpers/audit";
import { rolloutRestart } from "@/lib/k8s";

import { GET, PUT, DELETE } from "@/app/api/profiles/[name]/route";

// ── Fixtures ───────────────────────────────────────────────────────────────────

// A fully-formed DemoProfile as returned by loadProfile().
const STORED_PROFILE = {
  name: "scene-alpha",
  savedAt: "2026-01-01T00:00:00.000Z",
  savedBy: "operator",
  scenarios: [
    {
      id: "s1",
      name: "Checkout anomaly",
      severity: "high" as const,
      channels: ["ui"] as ["ui"],
      sensorFilter: "*",
      keywords: ["unusual"],
      enabled: true,
    },
  ],
  vlmPrompt: "Describe what you see.",
  cameras: [
    {
      id: "cam-01",
      role: "checkout" as const,
      feeds: [
        {
          id: "feed-01",
          sensorId: "sensor-01",
          source: "rtsp",
          rtspUrl: "rtsp://camera01/live",
          vstRegistered: false,
          replayReady: false,
        },
      ],
    },
  ],
  rtviTuning: {},
  alertTuning: {},
  nimModel: "cosmos-reason2-8b",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeGetCtx(name: string) {
  const req = new Request(`http://localhost/api/profiles/${name}`) as unknown as Request;
  return { req, ctx: { params: Promise.resolve({ name }) } };
}

function makePutCtx(name: string, body?: unknown) {
  const req = new Request(`http://localhost/api/profiles/${name}`, {
    method: "PUT",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
  return { req, ctx: { params: Promise.resolve({ name }) } };
}

function makeDeleteCtx(name: string) {
  const req = new Request(`http://localhost/api/profiles/${name}`, { method: "DELETE" }) as unknown as Request;
  return { req, ctx: { params: Promise.resolve({ name }) } };
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(loadProfile).mockReset().mockReturnValue(STORED_PROFILE as never);
  vi.mocked(saveProfile).mockReset();
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);
  vi.mocked(rolloutRestart).mockReset().mockResolvedValue(undefined);

  // Default getDb: prepare().run() returns { changes: 1 } (row deleted).
  vi.mocked(getDb).mockReset().mockImplementation(() => ({
    prepare: vi.fn(() => ({ run: vi.fn().mockReturnValue({ changes: 1 }) })),
  }) as never);

  delete process.env.CONSOLE_RUNTIME;
  delete process.env.VSS_INSTANCE_NAME;
});

// ── GET ────────────────────────────────────────────────────────────────────────

describe("GET /api/profiles/[name]", () => {
  it("happy path: returns loaded profile in { profile } envelope", async () => {
    const { req, ctx } = makeGetCtx("scene-alpha");
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toEqual(STORED_PROFILE);
    expect(loadProfile).toHaveBeenCalledWith("scene-alpha");
  });

  it("profile not found: loadProfile returns null → 404", async () => {
    vi.mocked(loadProfile).mockReturnValue(null);

    const { req, ctx } = makeGetCtx("nonexistent");
    const res = await GET(req, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const { req, ctx } = makeGetCtx("scene-alpha");
    const res = await GET(req, ctx);

    expect(res.status).toBe(401);
    expect(loadProfile).not.toHaveBeenCalled();
  });
});

// ── PUT ────────────────────────────────────────────────────────────────────────

describe("PUT /api/profiles/[name]", () => {
  it("happy path (K8s mode): profile applied, audit logged, returns 200", async () => {
    const { req, ctx } = makePutCtx("scene-alpha");
    const res = await PUT(req, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe("scene-alpha");

    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith(
      "profile-apply",
      "profile/scene-alpha",
      expect.objectContaining({ name: "scene-alpha" })
    );
  });

  it("profile not found → 404", async () => {
    vi.mocked(loadProfile).mockReturnValue(null);

    const { req, ctx } = makePutCtx("nonexistent");
    const res = await PUT(req, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("kiosk mode: rejectIfKiosk returns 403 → short-circuits, no apply", async () => {
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

    const { req, ctx } = makePutCtx("scene-alpha");
    const res = await PUT(req, ctx);

    expect(res.status).toBe(403);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const { req, ctx } = makePutCtx("scene-alpha");
    const res = await PUT(req, ctx);

    expect(res.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
  });
});

// ── DELETE ─────────────────────────────────────────────────────────────────────

describe("DELETE /api/profiles/[name]", () => {
  it("happy path: deletes via DB, audit logged, returns 200", async () => {
    const mockRun = vi.fn().mockReturnValue({ changes: 1 });
    const mockPrepare = vi.fn(() => ({ run: mockRun }));
    vi.mocked(getDb).mockReturnValue({ prepare: mockPrepare } as never);

    const { req, ctx } = makeDeleteCtx("scene-alpha");
    const res = await DELETE(req, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe("scene-alpha");

    expect(mockPrepare).toHaveBeenCalledWith("DELETE FROM profiles WHERE name = ?");
    expect(mockRun).toHaveBeenCalledWith("scene-alpha");

    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith("profile-delete", "profile/scene-alpha", { name: "scene-alpha" });
  });

  it("profile not found (changes === 0) → 404", async () => {
    const mockRun = vi.fn().mockReturnValue({ changes: 0 });
    const mockPrepare = vi.fn(() => ({ run: mockRun }));
    vi.mocked(getDb).mockReturnValue({ prepare: mockPrepare } as never);

    const { req, ctx } = makeDeleteCtx("nonexistent");
    const res = await DELETE(req, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("kiosk mode: rejectIfKiosk returns 403 → short-circuits, no delete", async () => {
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

    const mockRun = vi.fn().mockReturnValue({ changes: 1 });
    const mockPrepare = vi.fn(() => ({ run: mockRun }));
    vi.mocked(getDb).mockReturnValue({ prepare: mockPrepare } as never);

    const { req, ctx } = makeDeleteCtx("scene-alpha");
    const res = await DELETE(req, ctx);

    expect(res.status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const mockRun = vi.fn().mockReturnValue({ changes: 1 });
    const mockPrepare = vi.fn(() => ({ run: mockRun }));
    vi.mocked(getDb).mockReturnValue({ prepare: mockPrepare } as never);

    const { req, ctx } = makeDeleteCtx("scene-alpha");
    const res = await DELETE(req, ctx);

    expect(res.status).toBe(401);
    expect(mockRun).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });
});
