import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock infrastructure ─────────────────────────────────────────────
//
// vi.mock() factories are hoisted before any `const` declarations in this
// module, so we use vi.hoisted() to create the spies first.

const {
  mockLoadFromCluster,
  mockLoadFromDefault,
  mockMakeApiClient,
  MockKubeConfig,
  MockCoreV1Api,
  MockAppsV1Api,
  MockBatchV1Api,
  mockListNamespacedPod,
  mockPatchNamespacedDeployment,
  mockPatchNamespacedStatefulSet,
  mockExecFn,
  MockExec,
  mockExistsSync,
} = vi.hoisted(() => {
  const mockListNamespacedPod = vi.fn();
  const mockPatchNamespacedDeployment = vi.fn();
  const mockPatchNamespacedStatefulSet = vi.fn();

  const mockExecFn = vi.fn();
  const MockExec = vi.fn().mockImplementation(function () {
    return { exec: mockExecFn };
  });

  // Stub API classes — identity matters for makeApiClient dispatch
  function MockCoreV1Api() {}
  function MockAppsV1Api() {}
  function MockBatchV1Api() {}

  const mockMakeApiClient = vi.fn().mockImplementation((ApiClass: unknown) => {
    if (ApiClass === MockCoreV1Api) {
      return { listNamespacedPod: mockListNamespacedPod };
    }
    if (ApiClass === MockAppsV1Api) {
      return {
        patchNamespacedDeployment: mockPatchNamespacedDeployment,
        patchNamespacedStatefulSet: mockPatchNamespacedStatefulSet,
      };
    }
    return {};
  });

  const mockLoadFromCluster = vi.fn();
  const mockLoadFromDefault = vi.fn();
  const mockExistsSync = vi.fn();

  const MockKubeConfig = vi.fn().mockImplementation(function () {
    return {
      loadFromCluster: mockLoadFromCluster,
      loadFromDefault: mockLoadFromDefault,
      makeApiClient: mockMakeApiClient,
    };
  });

  return {
    mockLoadFromCluster,
    mockLoadFromDefault,
    mockMakeApiClient,
    MockKubeConfig,
    MockCoreV1Api,
    MockAppsV1Api,
    MockBatchV1Api,
    mockListNamespacedPod,
    mockPatchNamespacedDeployment,
    mockPatchNamespacedStatefulSet,
    mockExecFn,
    MockExec,
    mockExistsSync,
  };
});

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: MockKubeConfig,
  CoreV1Api: MockCoreV1Api,
  AppsV1Api: MockAppsV1Api,
  BatchV1Api: MockBatchV1Api,
  Exec: MockExec,
  setHeaderOptions: vi.fn((_key: string, _value: string) => ({ middleware: [] })),
  PatchStrategy: {
    JsonPatch: "application/json-patch+json",
    MergePatch: "application/merge-patch+json",
    StrategicMergePatch: "application/strategic-merge-patch+json",
    ServerSideApply: "application/apply-patch+yaml",
  },
}));

// getKubeConfig() picks loadFromCluster vs loadFromDefault by probing the
// in-cluster SA-token file with existsSync. Mock node:fs so the two branches
// are exercisable off-cluster; importOriginal keeps every other fs export real.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: mockExistsSync };
});

// ─── Module under test ────────────────────────────────────────────────────────

import {
  watchedNamespaces,
  coreV1,
  appsV1,
  listAllPodsInNs,
  runInPod,
  rolloutRestart,
  type PodRunResult,
} from "@/lib/k8s";

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let stderrWrites: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let warnSpy: any;

beforeEach(() => {
  vi.resetAllMocks();
  stderrWrites = [];
  stderrSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrWrites.push(String(args[0]));
  });
  warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    stderrWrites.push(String(args[0]));
  });
  vi.stubEnv("LOG_PRETTY", "0");

  // Re-apply default implementations cleared by resetAllMocks
  mockExistsSync.mockReturnValue(false); // off-cluster default — no SA token
  MockKubeConfig.mockImplementation(function () {
    return {
      loadFromCluster: mockLoadFromCluster,
      loadFromDefault: mockLoadFromDefault,
      makeApiClient: mockMakeApiClient,
    };
  });

  mockMakeApiClient.mockImplementation((ApiClass: unknown) => {
    if (ApiClass === MockCoreV1Api) {
      return { listNamespacedPod: mockListNamespacedPod };
    }
    if (ApiClass === MockAppsV1Api) {
      return {
        patchNamespacedDeployment: mockPatchNamespacedDeployment,
        patchNamespacedStatefulSet: mockPatchNamespacedStatefulSet,
      };
    }
    return {};
  });

  MockExec.mockImplementation(function () { return { exec: mockExecFn }; });
});

afterEach(() => {
  stderrSpy.mockRestore();
  warnSpy.mockRestore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.KUBE_NAMESPACES;
});

// ─── watchedNamespaces ────────────────────────────────────────────────────────

describe("watchedNamespaces", () => {
  it("returns Helm defaults when KUBE_NAMESPACES is not set (Helm mode, VSS_NAMESPACE=vss-base)", () => {
    delete process.env.KUBE_NAMESPACES;
    delete process.env.CONSOLE_LEGACY_NAMESPACES;
    process.env.VSS_NAMESPACE = "vss-base";
    const ns = watchedNamespaces();
    expect(ns).toContain("vss-base");
    expect(ns).toContain("demo-data");
    expect(ns).toContain("pyramid-ingress");
    delete process.env.VSS_NAMESPACE;
  });

  it("returns legacy defaults when CONSOLE_LEGACY_NAMESPACES=1", () => {
    delete process.env.KUBE_NAMESPACES;
    process.env.CONSOLE_LEGACY_NAMESPACES = "1";
    const ns = watchedNamespaces();
    expect(ns).toEqual(["vst", "rtvi", "agent", "alerts", "demo-data", "pyramid-ingress"]);
    delete process.env.CONSOLE_LEGACY_NAMESPACES;
  });

  it("returns a trimmed array when KUBE_NAMESPACES is set", () => {
    process.env.KUBE_NAMESPACES = "vst,rtvi,custom-ns";
    expect(watchedNamespaces()).toEqual(["vst", "rtvi", "custom-ns"]);
  });

  it("trims internal whitespace around each entry", () => {
    process.env.KUBE_NAMESPACES = "a, b ,c";
    expect(watchedNamespaces()).toEqual(["a", "b", "c"]);
  });
});

// ─── API client factories — loadFromCluster vs loadFromDefault ────────────────
//
// The KubeConfig singleton is module-level; to exercise the two branches we
// need vi.resetModules() + dynamic import to get a fresh module instance each
// time, so the singleton is not already populated from a previous test.

describe("coreV1 / appsV1 — kubeconfig selection", () => {
  it("uses loadFromCluster when the in-cluster SA token is present", async () => {
    // The top-level vi.mock()s are hoisted module-wide and survive
    // resetModules(), so the fresh dynamic import below still gets the mocked
    // @kubernetes/client-node and node:fs — no need to re-declare them here.
    vi.resetModules();

    mockExistsSync.mockReturnValue(true); // SA token file exists → in-cluster

    const { coreV1: freshCoreV1 } = await import("@/lib/k8s");
    freshCoreV1();

    expect(mockLoadFromCluster).toHaveBeenCalledTimes(1);
    expect(mockLoadFromDefault).not.toHaveBeenCalled();
  });

  it("uses loadFromDefault when there is no in-cluster SA token", async () => {
    vi.resetModules();

    mockExistsSync.mockReturnValue(false); // no SA token → off-cluster

    const { coreV1: freshCoreV1 } = await import("@/lib/k8s");
    freshCoreV1();

    expect(mockLoadFromDefault).toHaveBeenCalledTimes(1);
    expect(mockLoadFromCluster).not.toHaveBeenCalled();
  });
});

// ─── listAllPodsInNs ──────────────────────────────────────────────────────────

describe("listAllPodsInNs", () => {
  function fakePodListResponse(count: number, continueToken?: string, startId = 0) {
    return {
      items: Array.from({ length: count }, (_, i) => ({
        metadata: { name: `pod-${startId + i}` },
      })),
      metadata: continueToken ? { _continue: continueToken } : {},
    };
  }

  it("returns all items when there is only one page (no _continue token)", async () => {
    const fakeCore = { listNamespacedPod: mockListNamespacedPod } as never;
    mockListNamespacedPod.mockResolvedValueOnce(fakePodListResponse(3));

    const pods = await listAllPodsInNs(fakeCore, "vst");
    expect(pods).toHaveLength(3);
    expect(mockListNamespacedPod).toHaveBeenCalledTimes(1);
    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "vst" }),
    );
  });

  it("paginates across two pages, forwarding the _continue token", async () => {
    const fakeCore = { listNamespacedPod: mockListNamespacedPod } as never;
    mockListNamespacedPod
      .mockResolvedValueOnce(fakePodListResponse(3, "tok-abc", 0))
      .mockResolvedValueOnce(fakePodListResponse(2, undefined, 3));

    const pods = await listAllPodsInNs(fakeCore, "rtvi");
    expect(pods).toHaveLength(5);
    expect(mockListNamespacedPod).toHaveBeenCalledTimes(2);
    expect(mockListNamespacedPod).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ _continue: "tok-abc" }),
    );
  });

  it("stops at 10 pages and emits a structured warn log", async () => {
    const fakeCore = { listNamespacedPod: mockListNamespacedPod } as never;

    // Every response has a continue token so pagination would loop indefinitely
    // without the cap.
    mockListNamespacedPod.mockImplementation(() =>
      Promise.resolve(fakePodListResponse(1, "tok-infinite")),
    );

    const pods = await listAllPodsInNs(fakeCore, "alerts", { limit: 1 });
    expect(mockListNamespacedPod).toHaveBeenCalledTimes(10);
    expect(pods).toHaveLength(10);
    const warnRecords = stderrWrites.map((s) => JSON.parse(s));
    expect(warnRecords).toContainEqual(
      expect.objectContaining({ level: "warn", scope: "k8s", msg: expect.stringContaining("alerts") }),
    );
  });

  it("forwards labelSelector to every page call", async () => {
    const fakeCore = { listNamespacedPod: mockListNamespacedPod } as never;
    mockListNamespacedPod
      .mockResolvedValueOnce(fakePodListResponse(2, "tok-next"))
      .mockResolvedValueOnce(fakePodListResponse(1));

    await listAllPodsInNs(fakeCore, "agent", { labelSelector: "app=vss-worker" });

    expect(mockListNamespacedPod).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ labelSelector: "app=vss-worker" }),
    );
    expect(mockListNamespacedPod).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ labelSelector: "app=vss-worker" }),
    );
  });
});

// ─── runInPod ─────────────────────────────────────────────────────────────────

function fakePodResponse(name = "pod-0", containerName = "app") {
  return {
    items: [
      {
        metadata: { name },
        spec: { containers: [{ name: containerName }] },
      },
    ],
    metadata: {},
  };
}

describe("runInPod", () => {
  it("resolves with stdout content and code=0 on Success status", async () => {
    mockListNamespacedPod.mockResolvedValueOnce(fakePodResponse());
    mockExecFn.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        stdout: NodeJS.WritableStream,
        _stderr: unknown,
        _stdin: null,
        _tty: boolean,
        statusCb: (s: Record<string, unknown>) => void,
      ) => {
        stdout.write(Buffer.from("hello world"));
        statusCb({ status: "Success" });
        return Promise.resolve({ on: vi.fn() });
      },
    );

    const result: PodRunResult = await runInPod("vst", "app=vst", ["echo", "hello world"]);
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("resolves with the numeric exit code parsed from the Failure status causes", async () => {
    mockListNamespacedPod.mockResolvedValueOnce(fakePodResponse());
    mockExecFn.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: unknown,
        _stderr: unknown,
        _stdin: null,
        _tty: boolean,
        statusCb: (s: Record<string, unknown>) => void,
      ) => {
        statusCb({ status: "Failure", details: { causes: [{ message: "2" }] } });
        return Promise.resolve({ on: vi.fn() });
      },
    );

    const result = await runInPod("vst", "app=vst", ["false"]);
    expect(result.code).toBe(2);
  });

  it("rejects when no running pod is found matching the selector", async () => {
    mockListNamespacedPod.mockResolvedValueOnce({ items: [], metadata: {} });

    await expect(runInPod("vst", "app=missing", ["ls"])).rejects.toThrow(
      /No running pod found/,
    );
  });

  it("rejects when the exec WebSocket emits an error event", async () => {
    mockListNamespacedPod.mockResolvedValueOnce(fakePodResponse());
    const wsError = new Error("WebSocket connection refused");

    mockExecFn.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: unknown,
        _stderr: unknown,
        _stdin: null,
        _tty: boolean,
        _statusCb: unknown,
      ) => {
        // Do NOT call statusCb — let the ws "error" event settle the promise.
        const listeners: Record<string, (arg: unknown) => void> = {};
        const ws = {
          on: vi.fn((event: string, cb: (arg: unknown) => void) => {
            listeners[event] = cb;
          }),
        };
        const p = Promise.resolve(ws);
        p.then(() => {
          setImmediate(() => listeners["error"]?.(wsError));
        });
        return p;
      },
    );

    await expect(
      runInPod("vst", "app=vst", ["bad-cmd"], 5_000),
    ).rejects.toThrow("WebSocket connection refused");
  });
});

// ─── rolloutRestart ───────────────────────────────────────────────────────────

describe("rolloutRestart", () => {
  it("patches a Deployment with a valid ISO restartedAt annotation", async () => {
    mockPatchNamespacedDeployment.mockResolvedValueOnce({});
    const before = new Date().toISOString();

    await rolloutRestart("Deployment", "rtvi", "rtvi-vlm");

    expect(mockPatchNamespacedDeployment).toHaveBeenCalledTimes(1);

    type PatchCall = {
      name: string;
      namespace: string;
      body: {
        spec: {
          template: {
            metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": string } };
          };
        };
      };
    };

    const [callArg] = mockPatchNamespacedDeployment.mock.calls[0] as [PatchCall];
    expect(callArg.name).toBe("rtvi-vlm");
    expect(callArg.namespace).toBe("rtvi");

    const restartedAt =
      callArg.body.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"];
    // Must be a valid ISO 8601 string
    expect(new Date(restartedAt).toISOString()).toBe(restartedAt);
    // Must be >= timestamp captured before the call
    expect(restartedAt >= before).toBe(true);
  });

  it("patches a StatefulSet and does not touch patchNamespacedDeployment", async () => {
    mockPatchNamespacedStatefulSet.mockResolvedValueOnce({});

    await rolloutRestart("StatefulSet", "alerts", "alert-worker-ss");

    expect(mockPatchNamespacedStatefulSet).toHaveBeenCalledTimes(1);
    expect(mockPatchNamespacedDeployment).not.toHaveBeenCalled();

    type PatchCall = { name: string; namespace: string };
    const [callArg] = mockPatchNamespacedStatefulSet.mock.calls[0] as [PatchCall];
    expect(callArg.name).toBe("alert-worker-ss");
    expect(callArg.namespace).toBe("alerts");
  });
});
