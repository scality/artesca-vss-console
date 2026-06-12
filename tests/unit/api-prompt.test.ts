import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { email: "op@test" } }) }));
vi.mock("@/lib/kiosk-server", () => ({ rejectIfKiosk: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/helpers/audit", () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/reconcile/context", () => ({ ReconcileContextError: class extends Error {}, makeReconcileContext: vi.fn() }));
vi.mock("@/lib/reconcile/prompt", () => ({ reconcilePrompt: vi.fn().mockResolvedValue({ updated: true }) }));

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
vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn().mockResolvedValue({}),
  inspectContainer: vi.fn().mockResolvedValue(null),
  dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc123def456" }),
}));
vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsPromptGet: vi.fn().mockResolvedValue(null),
  gcsPromptPut: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    legacy: false,
    rtvi: {
      runtimeEnvCm: null,
      promptKey: "VLM_SYSTEM_PROMPT",
      modelKey: "VIA_VLM_OPENAI_MODEL_DEPLOYMENT_NAME",
      vlmDeployment: "vss-rtvi-vlm",
      nimStatefulSet: "cosmos-reason2-8b",
      nimNamespace: "vss-base",
    },
  },
}));

import { auth } from "@/lib/auth";
import { makeReconcileContext } from "@/lib/reconcile/context";
import { reconcilePrompt } from "@/lib/reconcile/prompt";
import { GET, PATCH } from "@/app/api/prompt/route";

function patchReq(body: unknown) {
  return new Request("http://localhost/api/prompt", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  delete process.env.CONSOLE_RUNTIME;
  vi.mocked(auth).mockResolvedValue({ user: { email: "op@test" } } as never);
});

describe("prompt route (k8s)", () => {
  it("GET returns the Firestore desired prompt", async () => {
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: {} as never,
      store: { readPrompt: vi.fn().mockResolvedValue({ prompt: "Watch the aisles", model: "nemotron" }) } as never,
    } as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt).toBe("Watch the aisles");
    expect(body.model).toBe("nemotron");
  });

  it("PATCH writes Firestore then applies write-through", async () => {
    const writePrompt = vi.fn().mockResolvedValue(undefined);
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "inst-1", adapter: {} as never, refs: { prompt: {}, scenarios: {} } as never,
      store: { writePrompt } as never,
    } as never);
    const res = await PATCH(patchReq({ prompt: "New prompt", model: "nemotron" }));
    expect(res.status).toBe(200);
    expect(writePrompt).toHaveBeenCalledWith("inst-1", { prompt: "New prompt", model: "nemotron" }, "op@test");
    expect(reconcilePrompt).toHaveBeenCalled();
  });
});
