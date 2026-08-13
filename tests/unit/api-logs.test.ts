/**
 * Unit tests for GET /api/logs/[ns]/[pod]/[container]
 *
 * The route has three layers:
 *   1. Auth guard          → 401 if no session
 *   2. Namespace allowlist → 403 if ns not in set
 *   3. SSE stream          → 200 text/event-stream
 *
 * Layer 3 uses real @kubernetes/client-node KubeConfig+Log (not coreV1) and
 * createSseResponse, which opens a ReadableStream.  We mock the heavy deps
 * (KubeConfig, Log, createSseResponse) to avoid needing a real K8s cluster.
 *
 * tailLines clamp: route does Math.min(Math.max(1, n), 5000) — verified by
 * capturing the onStart callback passed to createSseResponse and running it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted spy factories ────────────────────────────────────────────────────
// All spies are declared in a single hoisted block so vi.mock() factories can
// close over them.

const {
  mockAuth,
  mockLogLog,
  mockKubeConfigCtor,
  MockLogClass,
  mockCreateSseResponse,
} = vi.hoisted(() => {
  const mockAuth = vi.fn();
  const mockLogLog = vi.fn().mockResolvedValue(new AbortController());
  const mockKubeConfigCtor = vi.fn().mockImplementation(function () {
    return {
      loadFromCluster: vi.fn(),
      loadFromDefault: vi.fn(),
    };
  });
  const MockLogClass = vi.fn().mockImplementation(function () {
    return { log: mockLogLog };
  });
  const mockCreateSseResponse = vi.fn().mockReturnValue(
    new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    })
  );

  return {
    mockAuth,
    mockLogLog,
    mockKubeConfigCtor,
    MockLogClass,
    mockCreateSseResponse,
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

vi.mock("@/lib/streams/sse", () => ({ createSseResponse: mockCreateSseResponse }));


// Mock the entire @kubernetes/client-node so no real kubeconfig is needed.
vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: mockKubeConfigCtor,
  Log: MockLogClass,
  setHeaderOptions: vi.fn((_key: string, _value: string) => ({ middleware: [] })),
  PatchStrategy: {
    JsonPatch: "application/json-patch+json",
    MergePatch: "application/merge-patch+json",
    StrategicMergePatch: "application/strategic-merge-patch+json",
    ServerSideApply: "application/apply-patch+yaml",
  },
}));

// ── Module under test ────────────────────────────────────────────────────────

import { GET } from "@/app/api/logs/[ns]/[pod]/[container]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  ns: string,
  pod: string,
  container: string,
  searchParams: Record<string, string> = {}
) {
  const url = new URL(
    `http://localhost/api/logs/${ns}/${pod}/${container}`
  );
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  // Use NextRequest (not bare Request) so req.nextUrl is populated.
  return new NextRequest(url.toString());
}

function makeParams(ns: string, pod: string, container: string) {
  return { params: Promise.resolve({ ns, pod, container }) };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated session.
  mockAuth.mockResolvedValue({ user: { name: "operator" } });
  // Default: k8s mode.
  delete process.env.KUBE_NAMESPACES;
  // Use legacy namespace layout so "vst" is in the default allowlist.
  vi.stubEnv("CONSOLE_LEGACY_NAMESPACES", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/logs/[ns]/[pod]/[container]", () => {
  it("auth missing: no session → 401", async () => {
    mockAuth.mockResolvedValue(null);

    const req = makeRequest("vst", "vst-pod-abc", "vst");
    const res = await GET(req, makeParams("vst", "vst-pod-abc", "vst"));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    // SSE stream must not be opened.
    expect(mockCreateSseResponse).not.toHaveBeenCalled();
  });

  it("namespace NOT in default allowlist: returns 403, no SSE opened", async () => {
    // KUBE_NAMESPACES not set → default list used.
    const req = makeRequest("kube-system", "some-pod", "some-container");
    const res = await GET(
      req,
      makeParams("kube-system", "some-pod", "some-container")
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("namespace not in allowlist");
    expect(mockCreateSseResponse).not.toHaveBeenCalled();
  });

  it("namespace in default allowlist: opens SSE stream (200 text/event-stream)", async () => {
    const req = makeRequest("vst", "vst-pod-xyz", "vst");
    const res = await GET(req, makeParams("vst", "vst-pod-xyz", "vst"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(mockCreateSseResponse).toHaveBeenCalledOnce();
  });

  it("namespace in custom KUBE_NAMESPACES env: allowed, opens SSE", async () => {
    vi.stubEnv("KUBE_NAMESPACES", "mynamespace,anotherns");

    const req = makeRequest("mynamespace", "pod-1", "ctr-1");
    const res = await GET(req, makeParams("mynamespace", "pod-1", "ctr-1"));

    expect(res.status).toBe(200);
    expect(mockCreateSseResponse).toHaveBeenCalledOnce();
  });

  it("namespace NOT in custom KUBE_NAMESPACES env: 403", async () => {
    vi.stubEnv("KUBE_NAMESPACES", "mynamespace");

    // "vst" is in the default list but NOT in the custom env override.
    const req = makeRequest("vst", "pod-1", "ctr-1");
    const res = await GET(req, makeParams("vst", "pod-1", "ctr-1"));

    expect(res.status).toBe(403);
  });

  it("tailLines clamp: ?tail=99999 clamps to 5000 (route Math.min cap)", async () => {
    // Capture the onStart callback from createSseResponse so we can invoke the
    // K8s Log.log() path directly and inspect the tailLines value it receives.
    type OnStart = (write: (e: unknown) => void) => Promise<void | (() => void)>;
    let capturedOnStart: OnStart | undefined;

    mockCreateSseResponse.mockImplementationOnce(
      (_signal: AbortSignal, onStart: OnStart) => {
        capturedOnStart = onStart;
        return new Response(null, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
    );

    const req = makeRequest("vst", "pod-a", "ctr-a", { tailLines: "99999" });
    await GET(req, makeParams("vst", "pod-a", "ctr-a"));

    expect(capturedOnStart).toBeDefined();

    // Run the SSE producer — it builds KubeConfig + Log and calls log.log().
    await capturedOnStart!(vi.fn()).catch(() => {});

    // mockLogLog is the shared spy wired into MockLogClass instances via hoisted().
    expect(mockLogLog).toHaveBeenCalledOnce();
    // log.log(ns, pod, container, passthrough, options) — options is arg index 4.
    const opts = mockLogLog.mock.calls[0][4] as { tailLines: number };
    expect(opts.tailLines).toBe(5_000);
  });
});
