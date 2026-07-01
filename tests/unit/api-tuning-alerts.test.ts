import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

// Cooldown is enforced per-scenario. On k8s, Firestore is the source of truth
// for scenarios (the scenarios ConfigMap is reconciled FROM it), so the route
// reads/writes through the config store + triggers a reconcile.
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

class ReconcileContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileContextError";
  }
}

const mockReadScenarios = vi.fn();
const mockWriteScenarios = vi.fn();
const mockMakeReconcileContext = vi.fn();

vi.mock("@/lib/reconcile/context", () => ({
  ReconcileContextError,
  makeReconcileContext: (...args: unknown[]) => mockMakeReconcileContext(...args),
}));

const mockReconcileScenarios = vi.fn();

vi.mock("@/lib/reconcile/scenarios", () => ({
  reconcileScenarios: (...args: unknown[]) => mockReconcileScenarios(...args),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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
import { auditLog } from "@/lib/helpers/audit";
import type { ScenarioEntry } from "@/lib/config-store/types";

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

function scenarioEntry(overrides: Partial<ScenarioEntry> & { id: string }): ScenarioEntry {
  return {
    name: overrides.id,
    severity: "medium",
    channels: ["ui"],
    sensor_filter: "*",
    keywords: [],
    enabled: true,
    ...overrides,
  };
}

const TWO_SCENARIOS: ScenarioEntry[] = [
  scenarioEntry({ id: "forklift", name: "Forklift", cooldown_seconds: 180 }),
  scenarioEntry({ id: "intrusion", name: "Intrusion", cooldown_seconds: 60 }),
];

// ── Setup ────────────────────────────────────────────────────────────────────

const INSTANCE = "test-instance";

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  mockReadScenarios.mockReset().mockResolvedValue(structuredClone(TWO_SCENARIOS));
  mockWriteScenarios.mockReset().mockResolvedValue(undefined);
  mockReconcileScenarios.mockReset().mockResolvedValue({ updated: true });
  mockMakeReconcileContext.mockReset().mockResolvedValue({
    store: { readScenarios: mockReadScenarios, writeScenarios: mockWriteScenarios },
    adapter: { adapter: true },
    refs: { scenarios: { ns: "alerts", configMap: "scenarios", yamlKey: "scenarios.yaml", alertWorkerDeployment: "alert-worker" } },
    instance: INSTANCE,
  });

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

  it("happy path: returns the max cooldown_seconds across scenarios from the store", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cooldownSeconds).toBe(180);
    expect(body.slackWebhookConfigured).toBe(false);
    expect(mockReadScenarios).toHaveBeenCalledWith(INSTANCE);
  });

  it("scenarios with no cooldown set → 0", async () => {
    mockReadScenarios.mockResolvedValue([scenarioEntry({ id: "a", name: "A" })]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cooldownSeconds).toBe(0);
  });

  it("no scenarios in store → 0", async () => {
    mockReadScenarios.mockResolvedValue([]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cooldownSeconds).toBe(0);
  });

  it("config store unavailable (ReconcileContextError) → defaults with warning", async () => {
    mockMakeReconcileContext.mockRejectedValue(new ReconcileContextError("VSS_INSTANCE_NAME unset"));

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cooldownSeconds).toBe(120);
    expect(body.warning).toMatch(/config store unavailable/i);
    expect(mockReadScenarios).not.toHaveBeenCalled();
  });

  it("store read throws non-context error → 502", async () => {
    mockReadScenarios.mockRejectedValue(new Error("firestore read failed"));

    const res = await GET();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/firestore read failed/i);
  });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/tuning/alerts", () => {
  it("auth missing → 401, no writes", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(401);
    expect(mockWriteScenarios).not.toHaveBeenCalled();
  });

  it("kiosk mode → 403, no writes", async () => {
    vi.mocked(rejectIfKiosk).mockResolvedValue(
      NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 }),
    );

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(403);
    expect(mockWriteScenarios).not.toHaveBeenCalled();
  });

  it("invalid body: empty object → 400, no writes", async () => {
    const req = makeRequest("PATCH", {});
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(mockWriteScenarios).not.toHaveBeenCalled();
  });

  it("invalid body: negative cooldown → 400, no writes", async () => {
    const req = makeRequest("PATCH", { cooldownSeconds: -5 });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(mockWriteScenarios).not.toHaveBeenCalled();
  });

  it("happy path: cooldown written to all scenarios in the store, reconcile triggered, audited", async () => {
    const req = makeRequest("PATCH", { cooldownSeconds: 300 });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied.cooldownSeconds).toBe(300);
    expect(body.scenariosUpdated).toBe(2);

    expect(mockWriteScenarios).toHaveBeenCalledWith(
      INSTANCE,
      expect.arrayContaining([
        expect.objectContaining({ id: "forklift", cooldown_seconds: 300 }),
        expect.objectContaining({ id: "intrusion", cooldown_seconds: 300 }),
      ]),
      "operator@test.com",
    );
    // Every scenario got the new cooldown — none left at its old value.
    const writtenEntries = mockWriteScenarios.mock.calls[0][1] as ScenarioEntry[];
    expect(writtenEntries).toHaveLength(2);
    expect(writtenEntries.every((s) => s.cooldown_seconds === 300)).toBe(true);

    expect(mockReconcileScenarios).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "forklift", cooldown_seconds: 300 }),
        expect.objectContaining({ id: "intrusion", cooldown_seconds: 300 }),
      ]),
      expect.anything(),
      expect.objectContaining({ configMap: "scenarios", alertWorkerDeployment: "alert-worker" }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "tuning-alerts",
      expect.stringContaining(INSTANCE),
      expect.objectContaining({ cooldownSeconds: "300", scenariosUpdated: "2" }),
    );
  });

  it("slack-only PATCH → no-op (cooldown only on this chart), no store write / reconcile", async () => {
    const req = makeRequest("PATCH", { slackWebhookConfigured: true });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockWriteScenarios).not.toHaveBeenCalled();
    expect(mockReconcileScenarios).not.toHaveBeenCalled();
  });

  it("no scenarios to update → 409, no write", async () => {
    mockReadScenarios.mockResolvedValue([]);

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(409);
    expect(mockWriteScenarios).not.toHaveBeenCalled();
  });

  it("config store unavailable (ReconcileContextError) → 502, no audit", async () => {
    mockMakeReconcileContext.mockRejectedValue(new ReconcileContextError("Firestore init failed"));

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/read scenarios failed/i);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("store write fails → 502, no audit", async () => {
    mockWriteScenarios.mockRejectedValue(new Error("firestore write failed"));

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/write scenarios failed/i);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("reconcile returns an error → 200 with warning, still audited", async () => {
    mockReconcileScenarios.mockResolvedValue({ updated: false, error: "restart failed" });

    const req = makeRequest("PATCH", { cooldownSeconds: 60 });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warnings).toContain("restart failed");
    expect(auditLog).toHaveBeenCalled();
  });
});
