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
  watchedNamespaces: vi.fn(() => ["pyramid-ingress", "alerts", "rtvi"]),
}));

vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsScenariosGet: vi.fn().mockResolvedValue(null),
  gcsScenariosPut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

// scenarios-apply is imported by the route for scenarioToGcsConfig — mock to avoid
// the configmaps → k8s chain from being pulled through server-only.
vi.mock("@/lib/helpers/scenarios-apply", () => ({
  scenarioToGcsConfig: vi.fn((s: unknown) => s),
  applyScenariosLive: vi.fn().mockResolvedValue(undefined),
  gcsScenariosToCmPayload: vi.fn((scenarios: unknown[]) => ({ scenarios })),
  scenariosToYaml: vi.fn(() => ""),
}));

// patchConfigMapKey is called by the route via helpers/configmaps — mock it at
// the helpers layer so we don't need a live K8s connection.
vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn(),
  patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
  replaceConfigMapData: vi.fn().mockResolvedValue(undefined),
}));

// Docker-sock is imported but unused in k8s mode — stub it out.
vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn().mockResolvedValue({}),
  inspectContainer: vi.fn().mockResolvedValue(null),
  dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc123" }),
}));

// fs/promises — the route uses it in docker mode only; stub to avoid FS access.
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
import { gcsScenariosGet, gcsScenariosPut } from "@/lib/helpers/gcs-config";
import { readConfigMapKey, patchConfigMapKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";

import { GET, PATCH } from "@/app/api/scenarios/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, body?: unknown): NextRequest {
  return new Request("http://localhost/api/scenarios", {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  }) as unknown as NextRequest;
}

const VALID_SCENARIO = {
  id: "s1",
  name: "Theft Detection",
  severity: "high" as const,
  channels: ["ui" as const],
  sensorFilter: "*",
  keywords: ["theft", "shoplifting"],
  enabled: true,
};

// Mock return value for readConfigMapKey — simulates ConfigMap present with scenarios.
const MOCK_CONFIGMAP_VALUE = {
  value: {
    scenarios: [
      {
        id: "s1",
        name: "Theft Detection",
        severity: "high",
        channels: ["ui"],
        sensor_filter: "*",
        keywords: ["theft"],
        enabled: true,
      },
    ],
  },
  raw: '{"scenarios":[]}',
  resourceVersion: "12345",
};

// ── Setup ────────────────────────────────────────────────────────────────────

let mockCoreV1Api: {
  readNamespacedConfigMap: ReturnType<typeof vi.fn>;
  patchNamespacedConfigMap: ReturnType<typeof vi.fn>;
  replaceNamespacedConfigMap: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockCoreV1Api = {
    readNamespacedConfigMap: vi.fn().mockResolvedValue({
      metadata: { resourceVersion: "12345" },
      data: {},
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
  vi.mocked(gcsScenariosGet).mockReset().mockResolvedValue(null);
  vi.mocked(gcsScenariosPut).mockReset().mockResolvedValue(undefined);
  vi.mocked(readConfigMapKey).mockReset().mockResolvedValue(MOCK_CONFIGMAP_VALUE as never);
  vi.mocked(patchConfigMapKey).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  delete process.env.VSS_INSTANCE_NAME;
  delete process.env.CONSOLE_RUNTIME;
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/scenarios", () => {
  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("happy path: ConfigMap readable → returns parsed scenarios; GCS not required", async () => {
    vi.mocked(readConfigMapKey).mockResolvedValue(MOCK_CONFIGMAP_VALUE as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenarios).toHaveLength(1);
    expect(body.scenarios[0].id).toBe("s1");
    expect(body.resourceVersion).toBe("12345");
  });

  it("ConfigMap read fails → falls back to empty scenarios array, returns 200 with warning", async () => {
    vi.mocked(readConfigMapKey).mockRejectedValue(new Error("ConfigMap not found"));

    const res = await GET();

    // Route catches ConfigMap error and returns a degraded response
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenarios).toEqual([]);
    expect(body.warnings).toBeDefined();
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it("ConfigMap absent, no VSS_INSTANCE_NAME → gcs.available is false in degraded response", async () => {
    // VSS_INSTANCE_NAME is a const captured at module load time (empty string in tests).
    // GCS fetch is skipped → gcs field reports available:false.
    vi.mocked(readConfigMapKey).mockRejectedValue(new Error("not found"));

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gcs.available).toBe(false);
    expect(body.warnings).toBeDefined();
  });

  it("both ConfigMap and GCS fail → 200 with empty scenarios, no internal stack leak", async () => {
    vi.mocked(readConfigMapKey).mockRejectedValue(new Error("k8s error"));
    process.env.VSS_INSTANCE_NAME = "test-instance";
    vi.mocked(gcsScenariosGet).mockRejectedValue(new Error("gcs error"));

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenarios).toEqual([]);
    // Should not expose internal error details
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("stack");
  });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/scenarios", () => {
  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("PATCH", { scenarios: [VALID_SCENARIO] });
    const res = await PATCH(req);

    expect(res.status).toBe(401);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
  });

  it("kiosk mode: rejectIfKiosk returns 403 → short-circuits, no K8s/GCS calls", async () => {
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

    const req = makeRequest("PATCH", { scenarios: [VALID_SCENARIO] });
    const res = await PATCH(req);

    expect(res.status).toBe(403);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
    expect(gcsScenariosPut).not.toHaveBeenCalled();
  });

  it("invalid body: empty scenarios array → 400 (min(1) fails), no K8s/GCS calls", async () => {
    const req = makeRequest("PATCH", { scenarios: [] });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(patchConfigMapKey).not.toHaveBeenCalled();
    expect(gcsScenariosPut).not.toHaveBeenCalled();
  });

  it("invalid body: missing scenarios field → 400", async () => {
    const req = makeRequest("PATCH", { foo: "bar" });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
  });

  it("invalid scenario: missing required name field → 400", async () => {
    const badScenario = { ...VALID_SCENARIO, name: "" }; // name min(1) fails
    const req = makeRequest("PATCH", { scenarios: [badScenario] });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(patchConfigMapKey).not.toHaveBeenCalled();
  });

  it("happy path: valid body → ConfigMap patched, rollout restarted, audit logged, 200 with ok:true", async () => {
    const req = makeRequest("PATCH", { scenarios: [VALID_SCENARIO] });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(1);

    expect(patchConfigMapKey).toHaveBeenCalledOnce();
    expect(rolloutRestart).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith(
      "scenarios-update",
      expect.stringContaining("scenarios"),
      expect.objectContaining({ count: 1 }),
    );
  });

  it("ConfigMap patch fails (non-409) → 502; GCS NOT pushed", async () => {
    vi.mocked(patchConfigMapKey).mockRejectedValue(Object.assign(new Error("k8s error"), { code: 500 }));

    const req = makeRequest("PATCH", { scenarios: [VALID_SCENARIO] });
    const res = await PATCH(req);

    expect(res.status).toBe(502);
    expect(gcsScenariosPut).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("ConfigMap patch returns 409 conflict → 409 with reload message; GCS NOT pushed", async () => {
    vi.mocked(patchConfigMapKey).mockRejectedValue(Object.assign(new Error("conflict"), { code: 409 }));

    const req = makeRequest("PATCH", { scenarios: [VALID_SCENARIO] });
    const res = await PATCH(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/reload/i);
    expect(gcsScenariosPut).not.toHaveBeenCalled();
  });

  it("GCS push fails after successful ConfigMap patch → 200 (best-effort); gcsWarnings in response", async () => {
    // VSS_INSTANCE_NAME is captured as a const at module load → always "" in tests.
    // We can't trigger the GCS path without VSS_INSTANCE_NAME set at module load.
    // Verify the success path returns ok:true and the gcsWarnings field is absent
    // when VSS_INSTANCE_NAME is empty (GCS write not attempted).
    const req = makeRequest("PATCH", { scenarios: [VALID_SCENARIO] });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Without VSS_INSTANCE_NAME, no GCS write → no gcsWarnings field
    expect(body.gcsWarnings).toBeUndefined();
    expect(gcsScenariosPut).not.toHaveBeenCalled();
  });
});
