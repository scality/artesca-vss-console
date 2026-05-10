import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (must precede imports) ─────────────────────────────────────

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({
    readNamespacedConfigMap: vi.fn(),
    patchNamespacedConfigMap: vi.fn(),
    replaceNamespacedConfigMap: vi.fn(),
    createNamespacedConfigMap: vi.fn(),
  })),
  rolloutRestart: vi.fn(),
}));

vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMap: vi.fn(),
  writeConfigMap: vi.fn(),
  patchConfigMapRawKey: vi.fn(),
  patchConfigMapKey: vi.fn(),
}));

// prompt-apply.ts has its own local dockerRecreateWithEnv that calls dockerSock
// internally. We mock dockerSock at the module boundary so both readPromptLive
// and applyPromptLive (docker mode) go through our controlled fake.
vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn(),
}));

// server-only is already stubbed in tests/setup.ts

import * as k8sMod from "@/lib/k8s";
import * as configmapsMod from "@/lib/helpers/configmaps";
import * as dockerSockMod from "@/lib/helpers/docker-sock";
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

    const result = await readPromptLive(false);

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

    const result = await readPromptLive(false);
    expect(result).toBe("");
  });

  it("docker mode: inspects rtvi-vlm container and returns VLM_SYSTEM_PROMPT", async () => {
    vi.mocked(dockerSockMod.dockerSock).mockResolvedValue({
      Config: {
        Env: ["OTHER=val", "VLM_SYSTEM_PROMPT=hello from docker"],
      },
    });

    const result = await readPromptLive(true);
    expect(result).toBe("hello from docker");
    expect(dockerSockMod.dockerSock).toHaveBeenCalledWith(
      "GET",
      `/containers/${encodeURIComponent("rtvi-vlm")}/json`,
    );
  });

  it("docker mode: returns empty string when VLM_SYSTEM_PROMPT env var is absent", async () => {
    vi.mocked(dockerSockMod.dockerSock).mockResolvedValue({
      Config: { Env: ["OTHER=val"] },
    });

    const result = await readPromptLive(true);
    expect(result).toBe("");
  });
});

// ─── applyPromptLive ──────────────────────────────────────────────────────────

describe("applyPromptLive", () => {
  it("k8s mode: patches rtvi-runtime-env ConfigMap with the new prompt", async () => {
    vi.mocked(configmapsMod.patchConfigMapRawKey).mockResolvedValue(undefined);

    await applyPromptLive(false, "you are a retail analyst");

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

    await expect(applyPromptLive(false, "new prompt")).rejects.toThrow("K8s 409 Conflict");
  });

  it("docker mode: recreates rtvi-vlm with updated VLM_SYSTEM_PROMPT via dockerSock", async () => {
    // applyPromptLive(docker) → local dockerRecreateWithEnv → multiple dockerSock calls:
    // GET inspect, POST stop, POST rename, POST create, POST start, DELETE backup
    const mockSock = vi.mocked(dockerSockMod.dockerSock);
    mockSock
      .mockResolvedValueOnce(fakeInspect())        // GET inspect
      .mockResolvedValueOnce({})                   // POST stop (best-effort)
      .mockResolvedValueOnce({})                   // POST rename → backup
      .mockResolvedValueOnce({ Id: "new-abc" })    // POST create
      .mockResolvedValueOnce({})                   // POST start
      .mockResolvedValueOnce({});                  // DELETE backup (best-effort)

    await applyPromptLive(true, "docker prompt text");

    // The create call must have been made — verify the new env is passed
    const createCall = mockSock.mock.calls.find(
      ([, path]) => typeof path === "string" && path.includes("/containers/create"),
    );
    expect(createCall).toBeDefined();
    const createBody = createCall![2] as { Env: string[] };
    expect(createBody.Env).toContain("VLM_SYSTEM_PROMPT=docker prompt text");
  });

  it("docker mode: propagates errors from the recreate flow (e.g. rename failure)", async () => {
    vi.mocked(dockerSockMod.dockerSock)
      .mockResolvedValueOnce(fakeInspect())  // GET inspect
      .mockResolvedValueOnce({})             // POST stop
      .mockRejectedValueOnce(new Error("rename failed: container not found"));

    await expect(applyPromptLive(true, "broken")).rejects.toThrow("rename failed");
  });
});
