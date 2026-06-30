import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/helpers/prometheus", () => ({
  promQuery: vi.fn().mockResolvedValue({ results: [] }),
}));

vi.mock("@/lib/helpers/vst", () => ({
  vstListSensors: vi.fn().mockResolvedValue({ sensors: [], warning: undefined }),
}));

// Mock Kafka admin interface
const mockAdmin = {
  connect: vi.fn().mockResolvedValue(undefined),
  listTopics: vi.fn().mockResolvedValue([]),
  disconnect: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@/lib/kafka", () => ({
  getKafka: vi.fn().mockReturnValue({
    status: "connected",
    instance: { admin: () => mockAdmin },
  }),
}));

vi.mock("@/lib/s3", () => ({
  makeS3Client: vi.fn().mockReturnValue({
    send: vi.fn().mockResolvedValue({}),
  }),
  s3Endpoint: vi.fn().mockReturnValue("http://s3.example.com"),
  s3BucketForRecordings: vi.fn().mockReturnValue("test-bucket"),
}));

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn().mockReturnValue({
    listNamespace: vi.fn().mockResolvedValue({ items: [] }),
  }),
}));

vi.mock("@/lib/reconcile/context", () => ({
  makeReconcileContext: vi.fn(),
}));

// HeadBucketCommand must be a constructable mock — use a class so `new` works.
vi.mock("@aws-sdk/client-s3", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HeadBucketCommand: class MockHeadBucketCommand {
    constructor(public input: unknown) {}
  },
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { promQuery } from "@/lib/helpers/prometheus";
import { vstListSensors } from "@/lib/helpers/vst";
import { getKafka } from "@/lib/kafka";
import { makeS3Client, s3Endpoint } from "@/lib/s3";
import { coreV1 } from "@/lib/k8s";
import { makeReconcileContext } from "@/lib/reconcile/context";
import { collectConnectivity } from "@/lib/diagnostics/connectivity";
import type { BackendStatus } from "@/lib/diagnostics/connectivity";

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(promQuery).mockReset().mockResolvedValue({ results: [] });
  vi.mocked(vstListSensors).mockReset().mockResolvedValue({ sensors: [], warning: undefined });

  mockAdmin.connect.mockReset().mockResolvedValue(undefined);
  mockAdmin.listTopics.mockReset().mockResolvedValue([]);
  mockAdmin.disconnect.mockReset().mockResolvedValue(undefined);

  vi.mocked(getKafka).mockReset().mockReturnValue({
    status: "connected",
    instance: { admin: () => mockAdmin },
  } as never);

  const mockClient = { send: vi.fn().mockResolvedValue({}) };
  vi.mocked(makeS3Client).mockReset().mockReturnValue(mockClient as never);
  vi.mocked(s3Endpoint).mockReset().mockReturnValue("http://s3.example.com");

  vi.mocked(coreV1).mockReset().mockReturnValue({
    listNamespace: vi.fn().mockResolvedValue({ items: [] }),
  } as never);

  // config-store probe: instance set + a resolving context/read → "ok" fast,
  // deterministic, no real Firestore or 4s timeout.
  process.env.VSS_INSTANCE_NAME = "test-instance";
  delete process.env.CONSOLE_DISABLE_RECONCILE_LOOP;
  vi.mocked(makeReconcileContext)
    .mockReset()
    .mockResolvedValue({
      store: { readStatus: vi.fn().mockResolvedValue({}) },
      instance: "test-instance",
    } as never);

  // Alert-bridge probe uses global fetch — default to a reachable response so
  // the unrelated per-backend tests aren't perturbed. Cases below re-stub it.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ incidents: [] }),
    } as Response)
  );
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("collectConnectivity()", () => {
  it("returns all seven backends in stable order: k8s, prometheus, kafka, vst, s3, alert-bridge, config-store", async () => {
    const result = await collectConnectivity();

    expect(result).toHaveLength(7);
    const ids = result.map((b) => b.id);
    expect(ids).toEqual(["k8s", "prometheus", "kafka", "vst", "s3", "alert-bridge", "config-store"]);
  });

  it("does not include a mediamtx / camera-sim probe", async () => {
    const result = await collectConnectivity();
    const ids = result.map((b) => b.id);
    expect(ids).not.toContain("mediamtx");
  });

  it("each backend entry has the required shape (id, label, ok, detail, latencyMs)", async () => {
    const result = await collectConnectivity();

    for (const backend of result) {
      expect(backend).toHaveProperty("id");
      expect(backend).toHaveProperty("label");
      expect(typeof backend.ok).toBe("boolean");
      expect(typeof backend.detail).toBe("string");
      expect(typeof backend.latencyMs).toBe("number");
      expect(backend.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  // ── k8s ────────────────────────────────────────────────────────────────────

  it("k8s: ok=true + detail='reachable' when listNamespace() succeeds", async () => {
    vi.mocked(coreV1).mockReturnValue({
      listNamespace: vi.fn().mockResolvedValue({ items: [] }),
    } as never);

    const result = await collectConnectivity();
    const k8s = result.find((b) => b.id === "k8s")!;

    expect(k8s.ok).toBe(true);
    expect(k8s.detail).toBe("reachable");
    expect(k8s.label).toBe("K8s API");
  });

  it("k8s: ok=false + detail=error message when listNamespace() rejects", async () => {
    vi.mocked(coreV1).mockReturnValue({
      listNamespace: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as never);

    const result = await collectConnectivity();
    const k8s = result.find((b) => b.id === "k8s")!;

    expect(k8s.ok).toBe(false);
    expect(k8s.detail).toContain("connection refused");
  });

  // ── prometheus ─────────────────────────────────────────────────────────────

  it("prometheus: ok=true + detail='reachable' when promQuery has no warning", async () => {
    vi.mocked(promQuery).mockResolvedValue({ results: [] });

    const result = await collectConnectivity();
    const prom = result.find((b) => b.id === "prometheus")!;

    expect(prom.ok).toBe(true);
    expect(prom.detail).toBe("reachable");
    expect(prom.label).toBe("Prometheus");
  });

  it("prometheus: ok=false + detail=warning when promQuery returns a warning", async () => {
    vi.mocked(promQuery).mockResolvedValue({
      results: [],
      warning: "Prometheus unreachable: ECONNREFUSED",
    });

    const result = await collectConnectivity();
    const prom = result.find((b) => b.id === "prometheus")!;

    expect(prom.ok).toBe(false);
    expect(prom.detail).toBe("Prometheus unreachable: ECONNREFUSED");
  });


  // ── kafka ──────────────────────────────────────────────────────────────────

  it("kafka: ok=false + detail='not configured (KAFKA_BROKERS unset)' when instance is null", async () => {
    vi.mocked(getKafka).mockReturnValue({ status: "disconnected", instance: null } as never);

    const result = await collectConnectivity();
    const kafka = result.find((b) => b.id === "kafka")!;

    expect(kafka.ok).toBe(false);
    expect(kafka.detail).toBe("not configured (KAFKA_BROKERS unset)");
    expect(kafka.label).toBe("Kafka");
  });

  it("kafka: ok=true + detail='reachable' when admin connect+listTopics succeeds", async () => {
    mockAdmin.connect.mockResolvedValue(undefined);
    mockAdmin.listTopics.mockResolvedValue(["topic-1"]);

    const result = await collectConnectivity();
    const kafka = result.find((b) => b.id === "kafka")!;

    expect(kafka.ok).toBe(true);
    expect(kafka.detail).toBe("reachable");
    expect(mockAdmin.connect).toHaveBeenCalledOnce();
    expect(mockAdmin.listTopics).toHaveBeenCalledOnce();
    expect(mockAdmin.disconnect).toHaveBeenCalledOnce();
  });

  it("kafka: ok=false + detail=error message when admin connect throws", async () => {
    mockAdmin.connect.mockRejectedValue(new Error("broker unavailable"));

    const result = await collectConnectivity();
    const kafka = result.find((b) => b.id === "kafka")!;

    expect(kafka.ok).toBe(false);
    expect(kafka.detail).toContain("broker unavailable");
    // disconnect is still called via finally
    expect(mockAdmin.disconnect).toHaveBeenCalledOnce();
  });

  it("kafka: disconnect is called even when listTopics throws", async () => {
    mockAdmin.connect.mockResolvedValue(undefined);
    mockAdmin.listTopics.mockRejectedValue(new Error("metadata fetch failed"));

    const result = await collectConnectivity();
    const kafka = result.find((b) => b.id === "kafka")!;

    expect(kafka.ok).toBe(false);
    expect(kafka.detail).toContain("metadata fetch failed");
    expect(mockAdmin.disconnect).toHaveBeenCalledOnce();
  });

  // ── s3 ─────────────────────────────────────────────────────────────────────

  it("s3: ok=false + detail='not configured' when s3Endpoint() returns undefined", async () => {
    vi.mocked(s3Endpoint).mockReturnValue(undefined);

    const result = await collectConnectivity();
    const s3 = result.find((b) => b.id === "s3")!;

    expect(s3.ok).toBe(false);
    expect(s3.detail).toBe("not configured");
    expect(s3.label).toBe("S3");
  });

  it("s3: ok=true + detail='reachable' when HeadBucketCommand succeeds", async () => {
    vi.mocked(s3Endpoint).mockReturnValue("http://s3.example.com");
    const mockSend = vi.fn().mockResolvedValue({});
    vi.mocked(makeS3Client).mockReturnValue({ send: mockSend } as never);

    const result = await collectConnectivity();
    const s3 = result.find((b) => b.id === "s3")!;

    expect(s3.ok).toBe(true);
    expect(s3.detail).toBe("reachable");
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("s3: ok=false + detail=error message when HeadBucketCommand throws", async () => {
    vi.mocked(s3Endpoint).mockReturnValue("http://s3.example.com");
    const mockSend = vi.fn().mockRejectedValue(new Error("NoSuchBucket"));
    vi.mocked(makeS3Client).mockReturnValue({ send: mockSend } as never);

    const result = await collectConnectivity();
    const s3 = result.find((b) => b.id === "s3")!;

    expect(s3.ok).toBe(false);
    expect(s3.detail).toContain("NoSuchBucket");
  });

  // ── alert-bridge ─────────────────────────────────────────────────────────────

  it("alert-bridge: ok=true + detail='reachable' when GET /incidents returns 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ incidents: [] }) } as Response)
    );

    const result = await collectConnectivity();
    const ab = result.find((b) => b.id === "alert-bridge")!;

    expect(ab.ok).toBe(true);
    expect(ab.detail).toBe("reachable");
    expect(ab.label).toBe("Alert bridge (incidents)");
  });

  it("alert-bridge: ok=false + detail='HTTP 503' when the endpoint returns non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response)
    );

    const result = await collectConnectivity();
    const ab = result.find((b) => b.id === "alert-bridge")!;

    expect(ab.ok).toBe(false);
    expect(ab.detail).toBe("HTTP 503");
  });

  it("alert-bridge: ok=false + detail=error message when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await collectConnectivity();
    const ab = result.find((b) => b.id === "alert-bridge")!;

    expect(ab.ok).toBe(false);
    expect(ab.detail).toContain("ECONNREFUSED");
  });

  // ── type contract ──────────────────────────────────────────────────────────

  it("the BackendStatus type export has the exact contract shape", () => {
    // Verify via structural assignment — TypeScript compile-time check.
    const sample: BackendStatus = {
      id: "k8s",
      label: "K8s API",
      ok: true,
      detail: "reachable",
      latencyMs: 42,
    };
    // id must be one of the six union members
    const validIds: BackendStatus["id"][] = [
      "k8s",
      "prometheus",
      "kafka",
      "s3",
      "alert-bridge",
      "config-store",
    ];
    expect(validIds).toContain(sample.id);
  });
});
