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

// Cooldown is enforced per-scenario in the scenarios ConfigMap on every layout.
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    legacy: true,
    alertsTuning: {
      namespace: "alerts",
      configMap: "alerts-runtime-env",
      cooldownKey: "COOLDOWN_SECONDS",
      slackConfiguredKey: "SLACK_WEBHOOK_CONFIGURED",
    },
    scenarios: {
      namespace: "alerts",
      configMap: "scenarios",
      yamlKey: "scenarios.yaml",
      alertWorkerDeployment: "alert-worker",
    },
  },
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
import { patchConfigMapKey } from "@/lib/helpers/configmaps";
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

function scenariosCm(yaml: string) {
  return { metadata: { resourceVersion: "1" }, data: { "scenarios.yaml": yaml } };
}

const TWO_SCENARIOS = `scenarios:
  - id: forklift
    name: Forklift
    cooldown_seconds: 180
  - id: intrusion
    name: Intrusion
    cooldown_seconds: 60
`;

// ── Setup ────────────────────────────────────────────────────────────────────

let mockCoreV1Api: {
  readNamespacedConfigMap: ReturnType<typeof vi.fn>;
  patchNamespacedConfigMap: ReturnType<typeof vi.fn>;
  replaceNamespacedConfigMap: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockCoreV1Api = {
    readNamespacedConfigMap: vi.fn().mockResolvedValue(scenariosCm(TWO_SCENARIOS)),
    patchNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
  };

  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(coreV1).mockReset().mockReturnValue(mockCoreV1Api as never);
  vi.mocked(rolloutRestart).mockReset().mockResolvedValue(undefined);
  vi.mocked(patchConfigMapKey).mockReset().mockResolvedValue(undefined);
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

  it("happy path: returns the max cooldown_seconds across scenarios", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cooldownSeconds).toBe(180);
    expect(body.slackWebhookConfigured).toBe(false);
  });

  it("scenarios with no cooldown set → 0", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue(
      scenariosCm("scenarios:\n  - id: a\n    name: A\n"),
    );

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cooldownSeconds).toBe(0);
  });

  it("scenarios ConfigMap absent (404) → defaults with warning", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockRejectedValue(
      Object.assign(new Error("configmap not found"), { code: 404 }),
    );

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cooldownSeconds).toBe(120);
    expect(body.warning).toMatch(/not found/i);
  });

  it("scenarios ConfigMap read fails (503) → error status", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockRejectedValue(
      Object.assign(new Error("api server down"), { code: 503 }),
    );

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/tuning/alerts", () => {
  it("auth missing → 401, no writes", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(401);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
  });

  it("kiosk mode → 403, no writes", async () => {
    vi.mocked(rejectIfKiosk).mockResolvedValue(
      NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 }),
    );

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(403);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
  });

  it("invalid body: empty object → 400, no writes", async () => {
    const req = makeRequest("PATCH", {});
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
  });

  it("invalid body: negative cooldown → 400, no writes", async () => {
    const req = makeRequest("PATCH", { cooldownSeconds: -5 });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
  });

  it("happy path: cooldown applied to all scenarios, alert-worker restarted, audited", async () => {
    const req = makeRequest("PATCH", { cooldownSeconds: 300 });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied.cooldownSeconds).toBe(300);
    expect(body.scenariosUpdated).toBe(2);

    expect(patchConfigMapKey).toHaveBeenCalledWith(
      "alerts",
      "scenarios",
      "scenarios.yaml",
      expect.objectContaining({
        scenarios: expect.arrayContaining([
          expect.objectContaining({ id: "forklift", cooldown_seconds: 300 }),
          expect.objectContaining({ id: "intrusion", cooldown_seconds: 300 }),
        ]),
      }),
    );
    expect(rolloutRestart).toHaveBeenCalledWith("Deployment", "alerts", "alert-worker");
    expect(auditLog).toHaveBeenCalledWith(
      "tuning-alerts",
      expect.stringContaining("scenarios"),
      expect.objectContaining({ cooldownSeconds: "300", scenariosUpdated: "2" }),
    );
  });

  it("slack-only PATCH → no-op (cooldown only on this chart), no scenarios write", async () => {
    const req = makeRequest("PATCH", { slackWebhookConfigured: true });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
    expect(rolloutRestart).not.toHaveBeenCalled();
  });

  it("no scenarios to update → 409", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue(scenariosCm("scenarios: []\n"));

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(409);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
  });

  it("scenarios patch fails → error status, no audit", async () => {
    vi.mocked(patchConfigMapKey).mockRejectedValue(
      Object.assign(new Error("k8s write failed"), { code: 503 }),
    );

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(503);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("rollout restart fails → 502, no audit", async () => {
    vi.mocked(rolloutRestart).mockRejectedValue(new Error("rollout failed"));

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/rollout restart failed/i);
    expect(auditLog).not.toHaveBeenCalled();
  });
});
