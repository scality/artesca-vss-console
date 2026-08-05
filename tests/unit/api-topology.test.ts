import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

// listAllPodsInNs is the main call topology makes per namespace.
// coreV1 is called as a factory (coreV1()) whose return value is passed as the
// first arg to listAllPodsInNs, so we just need it to return a stable object.
vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({})),
  appsV1: vi.fn(() => ({})),
  watchedNamespaces: vi.fn(() => ["vss-base", "pyramid-ingress"]),
  listAllPodsInNs: vi.fn().mockResolvedValue([]),
}));

// The topology route also tries to fetch VST sensor list; stub global fetch so
// it returns an empty sensor list — avoids network calls in unit tests.
const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ sensors: [] }),
} as unknown as Response);
vi.stubGlobal("fetch", fetchMock);

// S3 probe — stub the client so HeadBucketCommand never actually fires.
vi.mock("@/lib/s3", () => ({
  makeS3Client: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
  s3Bucket: vi.fn(() => ""),     // empty → probeObjectStore returns "unknown"
  s3BucketForRecordings: vi.fn(() => ""),  // route.ts reads this for the display label
  s3Endpoint: vi.fn(() => ""),
}));

vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    legacy: false,
    vssNamespace: "vss-base",
    vst: { sensorListUrl: "http://vss-vios-sensor.vss-base.svc.cluster.local:30000/api/v1/live/sensor/list" },
  },
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { auth } from "@/lib/auth";
import { watchedNamespaces, listAllPodsInNs } from "@/lib/k8s";
import { GET } from "@/app/api/topology/route";

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(watchedNamespaces).mockReset().mockReturnValue([
    "vss-base", "pyramid-ingress",
  ]);
  vi.mocked(listAllPodsInNs).mockReset().mockResolvedValue([]);
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ sensors: [] }),
  } as unknown as Response);
  // Clear CONSOLE_RUNTIME so the k8s branch runs (not docker branch).
  delete process.env.CONSOLE_RUNTIME;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/topology", () => {
  it("auth missing: returns 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = new Request("http://localhost/api/topology");
    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(listAllPodsInNs).not.toHaveBeenCalled();
  });

  it("happy path: calls listAllPodsInNs for each watched namespace and returns nodes + edges", async () => {
    const req = new Request("http://localhost/api/topology");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();

    // Shape assertions
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);

    // At least the static COMPONENTS nodes are present (no pods → health=unknown)
    expect(body.nodes.length).toBeGreaterThan(0);

    // listAllPodsInNs called once per namespace
    const namespaces = vi.mocked(watchedNamespaces)();
    expect(listAllPodsInNs).toHaveBeenCalledTimes(namespaces.length);

    // Static edges are always emitted
    expect(body.edges.length).toBeGreaterThan(0);
  });

  it("pod with Running+Ready phase → component health resolved to 'ok'", async () => {
    // Inject a Running+Ready pod for the vss-vios-sensor deployment in vss-base (Helm path).
    vi.mocked(listAllPodsInNs).mockImplementation(async (_api, ns: string) => {
      if (ns === "vss-base") {
        return [
          {
            metadata: { name: "vss-vios-sensor-abc123" },
            status: {
              phase: "Running",
              conditions: [{ type: "Ready", status: "True" }],
            },
          },
        ] as never;
      }
      return [];
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    const sensorNode = body.nodes.find((n: { id: string }) => n.id === "vss-vios-sensor");
    expect(sensorNode).toBeDefined();
    expect(sensorNode.health).toBe("ok");
  });

  it("one namespace fails: topology still returns nodes from other namespaces, failure captured in warnings", async () => {
    vi.mocked(listAllPodsInNs).mockImplementation(async (_api, ns: string) => {
      if (ns === "vss-base") throw new Error("API timeout");
      return [];
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // Overall response still has nodes (the static COMPONENTS set)
    expect(body.nodes.length).toBeGreaterThan(0);

    // The failure is captured as a warning string
    expect(body.warnings.some((w: string) => w.includes("vss-base"))).toBe(true);
  });

  it("all namespace probes fail: still returns the static COMPONENTS nodes with health=unknown", async () => {
    vi.mocked(listAllPodsInNs).mockRejectedValue(new Error("apiserver down"));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // All static component nodes are emitted even without pod data
    expect(body.nodes.length).toBeGreaterThan(0);
    // Every node's health should be "unknown" (no pods → no healthMap entry)
    const healths: string[] = body.nodes.map((n: { health: string }) => n.health);
    expect(healths.every((h) => h === "unknown")).toBe(true);

    // A warning is emitted per failing namespace
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it.todo("docker mode branch: returns docker-shaped graph from docker.sock — full mock surface deferred");
  it.todo("feed sub-nodes: VST sensor list populated → dynamic nodes appended with parent=camera-sim");
});
