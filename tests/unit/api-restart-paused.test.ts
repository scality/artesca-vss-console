// POST /api/restart/[component] while the AI Factory has the box in another
// GPU mode: a restart of a workload the GPU switch scales answers 409 and does
// not patch; every other component restarts as before; vss mode restarts all.
//
// The box-mode module is the real one, reading through an injected reader, so
// the route's own guard is what is under test — rolloutRestart is mocked and
// carries no guard of its own here.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }) }));
vi.mock("@/lib/kiosk-server", () => ({ rejectIfKiosk: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/k8s", () => ({ rolloutRestart: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/helpers/audit", () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/cluster-refs", () => {
  const restartable = {
    "vss-rtvi-vlm": { namespace: "vss-alerts", kind: "Deployment", name: "vss-rtvi-vlm" },
    "vss-vios-streamprocessing": { namespace: "vss-alerts", kind: "StatefulSet", name: "vss-vios-streamprocessing" },
    "vss-agent": { namespace: "vss-alerts", kind: "Deployment", name: "vss-agent" },
  };
  return {
    CLUSTER: {
      restartable,
      rtvi: { vlmNamespace: "vss-alerts", vlmDeployment: "vss-rtvi-vlm" },
      vst: { namespace: "vss-alerts", streamProcessingDeployment: "vss-vios-streamprocessing", streamProcessingKind: "StatefulSet" },
      kvcache: { vllmNamespace: "kvcache-demo", vllmDeployment: "vllm-lmcache" },
      aiFactory: { url: "http://localhost:4090", modeNamespace: "ai-factory", modeConfigMap: "gpu-mode" },
    },
  };
});

import { rolloutRestart } from "@/lib/k8s";
import { auditLog } from "@/lib/helpers/audit";
import { resetBoxModeCache } from "@/lib/box-mode";
import { POST } from "@/app/api/restart/[component]/route";

const LLM = { data: { mode: "llm", pinned: "false", updatedAt: "2026-10-01T10:40:29.227Z" } };
const VSS = { data: { mode: "vss", updatedAt: "2026-10-01T07:36:10Z" } };

function post(component: string) {
  return POST(new Request(`http://localhost/api/restart/${component}`, { method: "POST" }) as never, {
    params: Promise.resolve({ component }),
  });
}

beforeEach(() => {
  vi.mocked(rolloutRestart).mockClear();
  vi.mocked(auditLog).mockClear();
});

describe("POST /api/restart/[component] — paused while the box is in llm mode", () => {
  it("409s a switch-owned Deployment and does not restart it", async () => {
    resetBoxModeCache({ reader: async () => LLM });
    const res = await post("vss-rtvi-vlm");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/^VSS paused — the box is running the LLM \(AI Factory\)\./);
    expect(body.error).toContain("deployment/vss-alerts/vss-rtvi-vlm");
    expect(body.boxMode).toMatchObject({ mode: "llm", source: "configmap" });
    expect(body.aiFactoryUrl).toBe("http://localhost:4090");
    expect(rolloutRestart).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("409s the switch-owned recorder StatefulSet too", async () => {
    resetBoxModeCache({ reader: async () => LLM });
    const res = await post("vss-vios-streamprocessing");
    expect(res.status).toBe(409);
    expect(rolloutRestart).not.toHaveBeenCalled();
  });

  it("still restarts a component the switch does not own", async () => {
    resetBoxModeCache({ reader: async () => LLM });
    const res = await post("vss-agent");
    expect(res.status).toBe(200);
    expect(rolloutRestart).toHaveBeenCalledWith("Deployment", "vss-alerts", "vss-agent");
  });

  it("restarts the VLM again once the box is back in vss mode", async () => {
    resetBoxModeCache({ reader: async () => VSS });
    const res = await post("vss-rtvi-vlm");
    expect(res.status).toBe(200);
    expect(rolloutRestart).toHaveBeenCalledWith("Deployment", "vss-alerts", "vss-rtvi-vlm");
  });

  it("restarts it on a box without the AI Factory (no record)", async () => {
    resetBoxModeCache({
      reader: async () => {
        throw Object.assign(new Error("not found"), { code: 404 });
      },
    });
    const res = await post("vss-rtvi-vlm");
    expect(res.status).toBe(200);
    expect(rolloutRestart).toHaveBeenCalledTimes(1);
  });
});
