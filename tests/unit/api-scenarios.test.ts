import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { email: "op@test" } }) }));
vi.mock("@/lib/kiosk-server", () => ({ rejectIfKiosk: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/helpers/audit", () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/reconcile/context", () => ({ ReconcileContextError: class extends Error {}, makeReconcileContext: vi.fn() }));
vi.mock("@/lib/reconcile/scenarios", () => ({ reconcileScenarios: vi.fn().mockResolvedValue({ updated: true }) }));

// Stub modules with import-time side effects so the route imports cleanly.
vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({})),
  appsV1: vi.fn(() => ({})),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn(),
  patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
  replaceConfigMapData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsScenariosGet: vi.fn().mockResolvedValue(null),
  gcsScenariosPut: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/helpers/scenarios-apply", () => ({
  scenarioToGcsConfig: vi.fn((s: unknown) => s),
  applyScenariosLive: vi.fn().mockResolvedValue(undefined),
  gcsScenariosToCmPayload: vi.fn((scenarios: unknown[]) => ({ scenarios })),
  scenariosToYaml: vi.fn(() => ""),
}));
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    scenarios: {
      namespace: "alerts",
      configMap: "scenarios",
      yamlKey: "scenarios.yaml",
      alertWorkerDeployment: "alert-worker",
    },
  },
}));

import { auth } from "@/lib/auth";
import { makeReconcileContext } from "@/lib/reconcile/context";
import { reconcileScenarios } from "@/lib/reconcile/scenarios";
import { GET, PATCH } from "@/app/api/scenarios/route";

const SCEN = { id: "fall", name: "Fall", severity: "high" as const, channels: ["ui" as const], sensorFilter: "*", keywords: ["fall"], enabled: true };
function patchReq(body: unknown) {
  return new Request("http://localhost/api/scenarios", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => { delete process.env.CONSOLE_RUNTIME; vi.mocked(auth).mockResolvedValue({ user: { email: "op@test" } } as never); });

describe("scenarios route (k8s)", () => {
  it("GET returns Firestore scenarios mapped to the client shape", async () => {
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: {} as never,
      store: { readScenarios: vi.fn().mockResolvedValue([{ id: "fall", name: "Fall", severity: "high", channels: ["ui"], sensor_filter: "*", keywords: ["fall"], enabled: true }]) } as never,
    } as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenarios[0].id).toBe("fall");
    expect(body.scenarios[0].sensorFilter).toBe("*");
  });

  it("PATCH writes Firestore then applies write-through", async () => {
    const writeScenarios = vi.fn().mockResolvedValue(undefined);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: { scenarios: {} } as never, store: { writeScenarios } as never,
    } as never);
    const res = await PATCH(patchReq({ scenarios: [SCEN] }));
    expect(res.status).toBe(200);
    expect(writeScenarios).toHaveBeenCalledWith("inst-1", expect.arrayContaining([expect.objectContaining({ id: "fall", sensor_filter: "*" })]), "op@test");
    expect(reconcileScenarios).toHaveBeenCalled();
  });

  it("GET returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("GET returns degraded response when config store unavailable", async () => {
    vi.mocked(makeReconcileContext).mockRejectedValue(new Error("Firestore init failed: creds missing"));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenarios).toEqual([]);
    expect(body.warnings).toBeDefined();
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it("PATCH returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PATCH(patchReq({ scenarios: [SCEN] }));
    expect(res.status).toBe(401);
  });

  it("PATCH returns 400 on invalid body", async () => {
    const res = await PATCH(patchReq({ scenarios: [] }));
    expect(res.status).toBe(400);
  });

  it("PATCH returns 502 when config store write fails", async () => {
    vi.mocked(makeReconcileContext).mockRejectedValue(new Error("Firestore unavailable"));
    const res = await PATCH(patchReq({ scenarios: [SCEN] }));
    expect(res.status).toBe(502);
  });
});
