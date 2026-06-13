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

import { makeReconcileContext } from "@/lib/reconcile/context";
import { reconcilePrompt } from "@/lib/reconcile/prompt";
import { GET, PATCH } from "@/app/api/prompt/route";

function patchReq(body: unknown) {
  return new Request("http://localhost/api/prompt", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => { delete process.env.CONSOLE_RUNTIME; });

describe("prompt-sets (k8s)", () => {
  it("GET returns sets + activeId + active prompt", async () => {
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "i1", adapter: {} as never, refs: {} as never,
      store: {
        readPromptSets: vi.fn().mockResolvedValue([{ id: "retail", name: "Retail", text: "t" }]),
        readActivePromptId: vi.fn().mockResolvedValue("retail"),
        readPrompt: vi.fn().mockResolvedValue({ prompt: "t" }),
      } as never,
    } as never);
    const res = await GET();
    const b = await res.json();
    expect(res.status).toBe(200);
    expect(b.sets[0].id).toBe("retail");
    expect(b.activePromptId).toBe("retail");
    expect(b.prompt).toBe("t");
  });

  it("PATCH {set} upserts; PATCH {activePromptId} sets active + applies write-through", async () => {
    const upsertPromptSet = vi.fn().mockResolvedValue(undefined);
    const setActivePromptId = vi.fn().mockResolvedValue(undefined);
    const readPrompt = vi.fn().mockResolvedValue({ prompt: "t" });
    vi.mocked(makeReconcileContext).mockResolvedValue({
      instance: "i1", adapter: {} as never, refs: { prompt: {} } as never,
      store: { upsertPromptSet, setActivePromptId, readPrompt } as never,
    } as never);
    await PATCH(patchReq({ set: { id: "wh", name: "WH", text: "x" } }));
    expect(upsertPromptSet).toHaveBeenCalledWith("i1", expect.objectContaining({ id: "wh" }), "op@test");
    await PATCH(patchReq({ activePromptId: "wh" }));
    expect(setActivePromptId).toHaveBeenCalledWith("i1", "wh", "op@test");
    expect(reconcilePrompt).toHaveBeenCalled();
  });
});
