import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({
    readNamespacedPod: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@/lib/errors", () => ({
  extractK8sError: vi.fn((e) => ({ status: 500, message: String(e) })),
}));

vi.mock("@/lib/helpers/docker-sock", () => ({
  inspectContainer: vi.fn().mockResolvedValue(null),
  dockerSock: vi.fn().mockResolvedValue(undefined),
  listComposeContainers: vi.fn().mockResolvedValue([]),
  DOCKER_TUNING_DIR: "/tmp/docker-tuning",
  dockerRecreateWithEnv: vi.fn().mockResolvedValue(undefined),
  runOneShotGpuContainer: vi.fn().mockResolvedValue(undefined),
  streamDockerLogs: vi.fn(),
  execInContainer: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { auth } from "@/lib/auth";
import { coreV1 } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";
import { GET } from "@/app/api/pods/[ns]/[name]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(ns: string, name: string) {
  return { params: Promise.resolve({ ns, name }) };
}

function makeRequest(): Request {
  return new Request("http://localhost/api/pods/vst/vst-0");
}

function makePod(overrides: Record<string, unknown> = {}) {
  return {
    metadata: { name: "vst-0", labels: {}, annotations: {} },
    status: {
      phase: "Running",
      conditions: [],
      containerStatuses: [
        {
          name: "vst",
          ready: true,
          restartCount: 0,
          image: "vst:latest",
          state: { running: { startedAt: "2026-05-10T08:00:00Z" } },
          lastState: {},
        },
      ],
      initContainerStatuses: [],
      startTime: "2026-05-10T08:00:00Z",
      podIP: "10.42.0.5",
    },
    spec: {
      nodeName: "node-1",
      containers: [{ name: "vst", resources: { requests: { cpu: "500m" }, limits: {} } }],
    },
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(extractK8sError).mockReset().mockImplementation((e) => ({
    status: 500,
    message: String(e),
  }));
  vi.mocked(coreV1).mockReset().mockImplementation(() => ({
    readNamespacedPod: vi.fn().mockResolvedValue(makePod()),
  }) as never);
  delete process.env.CONSOLE_RUNTIME;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/pods/[ns]/[name]", () => {
  it("happy path: returns pod details with 200", async () => {
    const res = await GET(makeRequest(), makeCtx("vst", "vst-0"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("vst-0");
    expect(body.namespace).toBe("vst");
    expect(body.phase).toBe("Running");
    expect(body.containers).toHaveLength(1);
    expect(body.containers[0].name).toBe("vst");
    expect(body.containers[0].ready).toBe(true);
    expect(body.node).toBe("node-1");
    expect(body.podIP).toBe("10.42.0.5");
  });

  it("pod not found (K8s 404) → 404 with error message", async () => {
    const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedPod: vi.fn().mockRejectedValue(notFound),
    }) as never);
    vi.mocked(extractK8sError).mockReturnValue({ status: 404, message: "pod not found" });

    const res = await GET(makeRequest(), makeCtx("vst", "vst-0"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("pod not found");
    expect(body.k8sCode).toBe(404);
  });

  it("K8s API error → 5xx status and extractK8sError message", async () => {
    const serverError = new Error("K8s server error");
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedPod: vi.fn().mockRejectedValue(serverError),
    }) as never);
    vi.mocked(extractK8sError).mockReturnValue({ status: 503, message: "K8s server error" });

    const res = await GET(makeRequest(), makeCtx("vst", "vst-0"));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("K8s server error");
    expect(extractK8sError).toHaveBeenCalledWith(serverError);
  });

  it("auth missing: returns 401 without calling K8s API", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const readMock = vi.fn();
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedPod: readMock,
    }) as never);

    const res = await GET(makeRequest(), makeCtx("vst", "vst-0"));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("pod with no containerStatuses → containers:[], initContainers:[]", async () => {
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedPod: vi.fn().mockResolvedValue(
        makePod({
          status: {
            phase: "Pending",
            conditions: [],
            containerStatuses: undefined,
            initContainerStatuses: undefined,
            startTime: null,
            podIP: null,
          },
        })
      ),
    }) as never);

    const res = await GET(makeRequest(), makeCtx("vst", "vst-pending"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.containers).toEqual([]);
    expect(body.initContainers).toEqual([]);
    expect(body.phase).toBe("Pending");
  });
});
