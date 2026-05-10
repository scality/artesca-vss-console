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
  dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc123def456" }),
  DOCKER_TUNING_DIR: "/tmp/test-tuning",
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("no file")),
  },
}));

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";

import { GET, PATCH } from "@/app/api/tuning/alerts/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, body?: unknown): NextRequest {
  return new Request("http://localhost/api/tuning/alerts", {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  }) as unknown as NextRequest;
}

// ── Setup ────────────────────────────────────────────────────────────────────

let mockCoreV1Api: {
  readNamespacedConfigMap: ReturnType<typeof vi.fn>;
  patchNamespacedConfigMap: ReturnType<typeof vi.fn>;
  replaceNamespacedConfigMap: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockCoreV1Api = {
    readNamespacedConfigMap: vi.fn().mockResolvedValue({
      metadata: { resourceVersion: "42" },
      data: {
        COOLDOWN_SECONDS: "180",
        SLACK_WEBHOOK_CONFIGURED: "true",
      },
    }),
    patchNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
  };

  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(coreV1).mockReset().mockReturnValue(mockCoreV1Api as never);
  vi.mocked(rolloutRestart).mockReset().mockResolvedValue(undefined);
  vi.mocked(patchConfigMapRawKey).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  delete process.env.CONSOLE_RUNTIME;
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/tuning/alerts", () => {
  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("happy path: ConfigMap present with values → returns parsed cooldownSeconds and slackWebhookConfigured", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue({
      metadata: { resourceVersion: "42" },
      data: {
        COOLDOWN_SECONDS: "180",
        SLACK_WEBHOOK_CONFIGURED: "true",
      },
    });
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cooldownSeconds).toBe(180);
    expect(body.slackWebhookConfigured).toBe(true);
  });

  it("ConfigMap data missing keys → returns defaults (120, false)", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue({
      metadata: { resourceVersion: "1" },
      data: {},
    });
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cooldownSeconds).toBe(120);
    expect(body.slackWebhookConfigured).toBe(false);
  });

  it("ConfigMap read fails → returns error status from extractK8sError", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockRejectedValue(
      Object.assign(new Error("configmap not found"), { code: 404 }),
    );
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("SLACK_WEBHOOK_CONFIGURED='false' → slackWebhookConfigured is false", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue({
      metadata: { resourceVersion: "3" },
      data: {
        COOLDOWN_SECONDS: "60",
        SLACK_WEBHOOK_CONFIGURED: "false",
      },
    });
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slackWebhookConfigured).toBe(false);
    expect(body.cooldownSeconds).toBe(60);
  });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/tuning/alerts", () => {
  it("auth missing → 401, no K8s calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(401);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("kiosk mode → 403, no K8s calls", async () => {
    vi.mocked(rejectIfKiosk).mockResolvedValue(
      NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 }),
    );

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
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

  it("invalid body: cooldownSeconds is negative → 400 (nonnegative fails), no K8s calls", async () => {
    const req = makeRequest("PATCH", { cooldownSeconds: -5 });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("happy path: valid cooldownSeconds → ConfigMap patched, rollout restarted, audit logged, 200 ok:true", async () => {
    const req = makeRequest("PATCH", { cooldownSeconds: 300 });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBeDefined();

    expect(patchConfigMapRawKey).toHaveBeenCalledWith(
      "alerts",
      "alerts-runtime-env",
      "COOLDOWN_SECONDS",
      "300",
    );
    expect(rolloutRestart).toHaveBeenCalledWith("Deployment", "alerts", "alert-worker");
    expect(auditLog).toHaveBeenCalledWith(
      "tuning-alerts",
      expect.stringContaining("alerts-runtime-env"),
      expect.objectContaining({ patches: expect.objectContaining({ COOLDOWN_SECONDS: "300" }) }),
    );
  });

  it("valid slackWebhookConfigured:true → SLACK_WEBHOOK_CONFIGURED='true' patched, 200 ok:true", async () => {
    const req = makeRequest("PATCH", { slackWebhookConfigured: true });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    expect(patchConfigMapRawKey).toHaveBeenCalledWith(
      "alerts",
      "alerts-runtime-env",
      "SLACK_WEBHOOK_CONFIGURED",
      "true",
    );
  });

  it("ConfigMap patch fails → error status from extractK8sError, no audit logged", async () => {
    vi.mocked(patchConfigMapRawKey).mockRejectedValue(
      Object.assign(new Error("k8s write failed"), { code: 503 }),
    );

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(503);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("rollout restart fails → 502, audit not called", async () => {
    vi.mocked(rolloutRestart).mockRejectedValue(new Error("rollout failed"));

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/rollout restart failed/i);
    expect(auditLog).not.toHaveBeenCalled();
  });
});
