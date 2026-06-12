import { describe, it, expect } from "vitest";
import { buildReconcileRefs } from "@/lib/reconcile/refs";

describe("buildReconcileRefs", () => {
  it("maps CLUSTER rtvi + scenarios fields into prompt/scenarios refs", () => {
    const fakeCluster = {
      rtvi: { vlmNamespace: "vss-base", vlmDeployment: "vss-rtvi-vlm", promptKey: "VLM_SYSTEM_PROMPT" },
      scenarios: {
        namespace: "vss-base",
        configMap: "scenarios",
        yamlKey: "scenarios.yaml",
        alertWorkerDeployment: "alert-worker",
      },
    };
    const refs = buildReconcileRefs(fakeCluster as never);
    expect(refs.prompt).toEqual({ ns: "vss-base", deployment: "vss-rtvi-vlm", promptKey: "VLM_SYSTEM_PROMPT" });
    expect(refs.scenarios).toEqual({
      ns: "vss-base",
      configMap: "scenarios",
      yamlKey: "scenarios.yaml",
      alertWorkerDeployment: "alert-worker",
    });
  });
});
