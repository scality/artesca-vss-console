import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (must precede imports) ─────────────────────────────────────

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({
    readNamespacedConfigMap: vi.fn(),
    patchNamespacedConfigMap: vi.fn(),
    replaceNamespacedConfigMap: vi.fn(),
    createNamespacedConfigMap: vi.fn(),
  })),
  appsV1: vi.fn(() => ({
    readNamespacedDeployment: vi.fn(),
    patchNamespacedDeployment: vi.fn(),
  })),
  rolloutRestart: vi.fn(),
  MERGE_PATCH_OPTS: { middleware: [] },
}));

// Force legacy layout so prompt-apply takes the ConfigMap path (runtimeEnvCm non-empty).
// In Helm mode runtimeEnvCm="" and the code patches the Deployment env instead.
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    legacy: true,
    rtvi: {
      runtimeEnvCm: "rtvi-runtime-env",
      promptKey: "RTVI_VLM_SYSTEM_PROMPT",
      vlmDeployment: "rtvi-vlm",
      nimNamespace: "rtvi",
    },
  },
}));

vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMap: vi.fn(),
  writeConfigMap: vi.fn(),
  patchConfigMapRawKey: vi.fn(),
  patchConfigMapKey: vi.fn(),
}));


// server-only is already stubbed in tests/setup.ts

import * as k8sMod from "@/lib/k8s";
import * as configmapsMod from "@/lib/helpers/configmaps";
import { readPromptLive, applyPromptLive } from "@/lib/helpers/prompt-apply";
import { CLUSTER } from "@/lib/cluster-refs";

// ─── Fake inspect response ────────────────────────────────────────────────────

function fakeInspect(envLines: string[] = ["VLM_SYSTEM_PROMPT=old"]) {
  return {
    Config: {
      Image: "rtvi:latest",
      Env: envLines,
      Cmd: ["serve"],
      Entrypoint: null,
      ExposedPorts: {},
      Labels: {},
      WorkingDir: "/app",
      User: "",
    },
    HostConfig: { NetworkMode: "bridge" },
    NetworkSettings: { Networks: { bridge: {} } },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCoreV1(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    readNamespacedConfigMap: vi.fn().mockResolvedValue({
      data: { [CLUSTER.rtvi.promptKey]: "default prompt" },
      metadata: { resourceVersion: "42" },
    }),
    patchNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── readPromptLive ───────────────────────────────────────────────────────────

describe("readPromptLive", () => {
  it("k8s mode: reads prompt from rtvi-runtime-env ConfigMap", async () => {
    const coreV1Impl = makeCoreV1();
    vi.mocked(k8sMod.coreV1).mockReturnValue(coreV1Impl as never);

    const result = await readPromptLive();

    expect(result).toBe("default prompt");
    expect(coreV1Impl.readNamespacedConfigMap).toHaveBeenCalledWith({
      name: CLUSTER.rtvi.runtimeEnvCm,
      namespace: CLUSTER.rtvi.nimNamespace,
    });
  });

  it("k8s mode: returns empty string when ConfigMap data key is absent", async () => {
    const coreV1Impl = makeCoreV1({
      readNamespacedConfigMap: vi.fn().mockResolvedValue({ data: {} }),
    });
    vi.mocked(k8sMod.coreV1).mockReturnValue(coreV1Impl as never);

    const result = await readPromptLive();
    expect(result).toBe("");
  });

});

// ─── applyPromptLive ──────────────────────────────────────────────────────────

describe("applyPromptLive", () => {
  it("k8s mode: patches rtvi-runtime-env ConfigMap with the new prompt", async () => {
    vi.mocked(configmapsMod.patchConfigMapRawKey).mockResolvedValue(undefined);

    await applyPromptLive("you are a retail analyst");

    expect(configmapsMod.patchConfigMapRawKey).toHaveBeenCalledWith(
      CLUSTER.rtvi.nimNamespace,
      CLUSTER.rtvi.runtimeEnvCm,
      CLUSTER.rtvi.promptKey,
      "you are a retail analyst",
    );
  });

  it("k8s mode: propagates errors from patchConfigMapRawKey", async () => {
    vi.mocked(configmapsMod.patchConfigMapRawKey).mockRejectedValue(
      new Error("K8s 409 Conflict"),
    );

    await expect(applyPromptLive("new prompt")).rejects.toThrow("K8s 409 Conflict");
  });

});
