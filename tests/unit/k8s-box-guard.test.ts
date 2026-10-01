// The backstop under every caller: rolloutRestart and scaleDeployment refuse a
// workload the AI Factory GPU switch scales while the box is not in `vss` mode,
// and patch everything else as before. cluster-refs is the real module with the
// default env (VSS_NAMESPACE unset → vss-base).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { patchDeployment, patchStatefulSet } = vi.hoisted(() => ({
  patchDeployment: vi.fn().mockResolvedValue({}),
  patchStatefulSet: vi.fn().mockResolvedValue({}),
}));

vi.mock("@kubernetes/client-node", () => {
  function CoreV1Api() {}
  function AppsV1Api() {}
  function BatchV1Api() {}
  return {
    KubeConfig: vi.fn().mockImplementation(function () {
      return {
        loadFromCluster: vi.fn(),
        loadFromDefault: vi.fn(),
        makeApiClient: (Api: unknown) =>
          Api === AppsV1Api ? { patchNamespacedDeployment: patchDeployment, patchNamespacedStatefulSet: patchStatefulSet } : {},
      };
    }),
    CoreV1Api,
    AppsV1Api,
    BatchV1Api,
    Exec: vi.fn(),
    setHeaderOptions: vi.fn(() => ({ middleware: [] })),
    PatchStrategy: { StrategicMergePatch: "application/strategic-merge-patch+json", JsonPatch: "application/json-patch+json" },
  };
});

import { rolloutRestart, scaleDeployment } from "@/lib/k8s";
import { resetBoxModeCache, BoxPausedError } from "@/lib/box-mode";

const LLM = { data: { mode: "llm", pinned: "false", updatedAt: "2026-10-01T10:40:29.227Z" } };

beforeEach(() => {
  patchDeployment.mockClear();
  patchStatefulSet.mockClear();
  resetBoxModeCache({ reader: async () => LLM });
});

describe("rolloutRestart / scaleDeployment in llm mode", () => {
  it("refuse the VLM Deployment and the recorder StatefulSet without patching", async () => {
    await expect(rolloutRestart("Deployment", "vss-base", "vss-rtvi-vlm")).rejects.toBeInstanceOf(BoxPausedError);
    await expect(rolloutRestart("StatefulSet", "vss-base", "vss-vios-streamprocessing")).rejects.toBeInstanceOf(BoxPausedError);
    await expect(scaleDeployment("kvcache-demo", "vllm-lmcache", 1)).rejects.toBeInstanceOf(BoxPausedError);
    expect(patchDeployment).not.toHaveBeenCalled();
    expect(patchStatefulSet).not.toHaveBeenCalled();
  });

  it("patch a workload the switch does not own", async () => {
    await rolloutRestart("Deployment", "vss-base", "alert-worker");
    await scaleDeployment("vss-base", "vlm-stream-reconciler", 0);
    expect(patchDeployment).toHaveBeenCalledTimes(2);
  });

  it("patch the VLM once the box is back in vss mode", async () => {
    resetBoxModeCache({ reader: async () => ({ data: { mode: "vss" } }) });
    await rolloutRestart("Deployment", "vss-base", "vss-rtvi-vlm");
    expect(patchDeployment).toHaveBeenCalledTimes(1);
  });
});
