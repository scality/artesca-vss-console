import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config-store/firestore", () => ({
  makeFirestoreConfigStore: vi.fn().mockResolvedValue({ readCameras: vi.fn() }),
}));
vi.mock("@/lib/reconcile/cluster-adapter", () => ({
  VstClusterAdapter: class { listSensors() { return []; } },
}));
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    rtvi: { vlmNamespace: "vss-base", vlmDeployment: "vss-rtvi-vlm", promptKey: "VLM_SYSTEM_PROMPT" },
    scenarios: { namespace: "vss-base", configMap: "scenarios", yamlKey: "scenarios.yaml", alertWorkerDeployment: "alert-worker" },
  },
}));

import { makeReconcileContext, ReconcileContextError } from "@/lib/reconcile/context";

beforeEach(() => { delete process.env.VSS_INSTANCE_NAME; });

describe("makeReconcileContext", () => {
  it("throws ReconcileContextError when VSS_INSTANCE_NAME is unset", async () => {
    await expect(makeReconcileContext()).rejects.toBeInstanceOf(ReconcileContextError);
  });

  it("returns store + adapter + refs + instance when configured", async () => {
    process.env.VSS_INSTANCE_NAME = "inst-1";
    const ctx = await makeReconcileContext();
    expect(ctx.instance).toBe("inst-1");
    expect(ctx.store).toBeDefined();
    expect(ctx.adapter).toBeDefined();
    expect(ctx.refs.prompt.deployment).toBe("vss-rtvi-vlm");
  });
});
