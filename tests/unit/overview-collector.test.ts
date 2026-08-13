/**
 * Unit tests for src/lib/overview-collector.ts
 *
 * Contract under test: both collectOverviewSnapshot() and collectPodSummaries()
 * ALWAYS resolve — even when every downstream probe throws.  Failures are
 * captured as warnings[] entries on the result, never surfaced as rejections.
 *
 * Mocking strategy:
 *  - Every external dependency is mocked at the module boundary via vi.mock().
 *  - vi.hoisted() builds the spy instances before module factories run
 *    (vitest hoists vi.mock() calls, so bare const declarations in the test
 *    file aren't initialised yet when the factory executes).
 *  - Tests control each probe independently via vi.mocked(fn).mockResolvedValue /
 *    mockRejectedValue per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted spy factories ──────────────────────────────────────────────────
//
// We create all spies here so vi.mock() factories can reference them.

const {
  mockListAllPodsInNs,
  mockCoreV1,
  mockWatchedNamespaces,
  mockBucketStatsCached,
  mockGetKafka,
  mockPromQuery,
  mockMediamtxListPaths,
  mockVstListSensors,
  mockListComposeContainers,
  mockInspectContainer,
  mockRunOneShotGpuContainer,
  mockS3Bucket,
  mockListIngestingCameras,
} = vi.hoisted(() => {
  const mockListAllPodsInNs = vi.fn();
  const mockCoreV1 = vi.fn(() => ({}));
  const mockWatchedNamespaces = vi.fn(() => ["vst", "rtvi", "agent"]);

  const mockBucketStatsCached = vi.fn();
  const mockGetKafka = vi.fn();
  const mockPromQuery = vi.fn();
  const mockMediamtxListPaths = vi.fn();
  const mockVstListSensors = vi.fn();
  const mockListComposeContainers = vi.fn();
  const mockInspectContainer = vi.fn();
  const mockRunOneShotGpuContainer = vi.fn();
  const mockS3Bucket = vi.fn(() => "test-bucket");
  const mockListIngestingCameras = vi.fn();

  return {
    mockListAllPodsInNs,
    mockCoreV1,
    mockWatchedNamespaces,
    mockBucketStatsCached,
    mockGetKafka,
    mockPromQuery,
    mockMediamtxListPaths,
    mockVstListSensors,
    mockListComposeContainers,
    mockInspectContainer,
    mockRunOneShotGpuContainer,
    mockS3Bucket,
    mockListIngestingCameras,
  };
});

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("@/lib/k8s", () => ({
  coreV1: mockCoreV1,
  appsV1: vi.fn(() => ({})),
  watchedNamespaces: mockWatchedNamespaces,
  listAllPodsInNs: mockListAllPodsInNs,
}));

vi.mock("@/lib/storage-substrate", () => ({
  bucketStatsCached: mockBucketStatsCached,
}));

vi.mock("@/lib/kafka", () => ({
  getKafka: mockGetKafka,
}));

vi.mock("@/lib/helpers/prometheus", () => ({
  promQuery: mockPromQuery,
}));

vi.mock("@/lib/helpers/mediamtx", () => ({
  mediamtxListPaths: mockMediamtxListPaths,
}));

vi.mock("@/lib/helpers/vst", () => ({
  vstListSensors: mockVstListSensors,
}));

// VLM-ingestion signal (cameras with an active realtime alert rule) — the
// collector reaches this via a dynamic import, but vi.mock intercepts both
// static and dynamic import forms of the same module path.
vi.mock("@/lib/helpers/ingestion", () => ({
  listIngestingCameras: mockListIngestingCameras,
}));


vi.mock("@/lib/s3", () => ({
  s3BucketForRecordings: mockS3Bucket,
  s3BucketForAlertClips: vi.fn(() => "nvidia-vss-alert-clips"),
  s3KeyForAlertClip: vi.fn(),
  makeS3Client: vi.fn(),
  s3Endpoint: vi.fn(() => undefined),
  s3Region: vi.fn(() => "us-west-2"),
  isAwsNativeEndpoint: vi.fn(() => true),
  // The collector formats every S3 warning through this. Omitting it does not
  // fail the suite — the call throws, the fail-soft catch swallows it, and a
  // warning still lands, so the degraded-path test below reaches its assertion
  // through the missing export rather than through the error it means to
  // simulate. The recognisable prefix is what lets that test tell the two apart.
  describeS3Error: vi.fn((err: unknown) => `described:${String(err)}`),
}));

// cluster-refs imports "server-only" — the global setup already mocks that.
// But cluster-refs itself is imported transitively (via prometheus/mediamtx
// helpers). Mock it to a flat object so it never hits process.env lookups
// that might be absent in the test environment.
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    prometheus: { url: "http://prometheus-test:9090" },
    mediamtx: { apiUrl: "http://mediamtx-test:9997" },
    kafka: { brokers: "kafka-test:9092", topics: {} },
    redis: { url: "redis://redis-test:6379" },
    vst: {},
    rtvi: {},
    alerts: {},
    nim: {},
    s3: { capacityBytes: 0 },
  },
}));

// ─── Module under test ──────────────────────────────────────────────────────
// Import AFTER all vi.mock() calls.

import {
  collectOverviewSnapshot,
  collectPodSummaries,
  type OverviewResult,
  type PodsResult,
} from "@/lib/overview-collector";

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** A valid PromQuery result with no GPU data. */
const emptyPromResult = { results: [] };

/** A minimal V1Pod shaped object that reports Ready. */
function makeReadyPod(name: string, ns: string) {
  return {
    metadata: { name, namespace: ns },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ restartCount: 0 }],
      startTime: new Date().toISOString(),
    },
    spec: { nodeName: "test-node" },
  };
}

function makeFailedPod(name: string, ns: string) {
  return {
    metadata: { name, namespace: ns },
    status: {
      phase: "Failed",
      conditions: [],
      containerStatuses: [{ restartCount: 2 }],
      startTime: new Date().toISOString(),
    },
    spec: { nodeName: "test-node" },
  };
}

/** A completed Job pod — terminal success, no Ready condition (mirrors a
 *  `kubectl run`-style one-shot like the leftover `aq` curl pod). */
function makeSucceededPod(name: string, ns: string) {
  return {
    metadata: { name, namespace: ns },
    status: {
      phase: "Succeeded",
      conditions: [],
      containerStatuses: [{ restartCount: 0 }],
      startTime: new Date().toISOString(),
    },
    spec: { nodeName: "test-node" },
  };
}

/** A Kafka admin mock that connects and fetches offsets successfully. */
function makeKafkaAdmin(topics: string[] = []) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    fetchTopicOffsets: vi.fn().mockResolvedValue([{ high: "10", low: "5" }]),
  };
}

/** Default happy-path setups for all k8s-mode probes. */
function setupK8sHappyPath() {
  // Force k8s mode.
  vi.stubEnv("CONSOLE_RUNTIME", "k8s");
  // Provide a kubeconfig-like env var so isDockerMode() → false path is taken.
  vi.stubEnv("KUBECONFIG", "/tmp/fake-kubeconfig");

  // Pods per namespace — all ready.
  mockListAllPodsInNs.mockResolvedValue([makeReadyPod("pod-a", "vst")]);

  // Prometheus — empty but successful.
  mockPromQuery.mockResolvedValue(emptyPromResult);

  // Kafka — configured with a working admin.
  const admin = makeKafkaAdmin();
  mockGetKafka.mockReturnValue({
    status: "connected",
    instance: { admin: vi.fn(() => admin) },
  });

  // S3 — a fresh cached value.
  mockBucketStatsCached.mockReturnValue({
    stats: {
      bucket: "test-bucket",
      objectCount: 42,
      bytesTotal: 1_000_000,
      bytesLast24h: 100_000,
    },
    refreshing: false,
  });

  // Camera-sim / mediamtx — working (docker path only).
  mockMediamtxListPaths.mockResolvedValue({
    paths: [
      { name: "cam1", ready: true },
      { name: "cam1-h264", ready: true }, // should be filtered out
    ],
    warning: undefined,
  });

  // VST sensor list — source-agnostic camera registry (k8s path).
  mockVstListSensors.mockResolvedValue({
    sensors: [{ sensor_id: "cam1", name: "cam1", status: "online" }],
    warning: undefined,
  });

  // VLM-ingestion signal — alert-bridge reachable, cam1 has an active rule.
  mockListIngestingCameras.mockResolvedValue({
    ingesting: new Set(["cam1"]),
    warning: undefined,
  });
}

/** Default happy-path setups for docker-mode probes. */
function setupDockerHappyPath() {
  vi.stubEnv("CONSOLE_RUNTIME", "docker");
  // Remove KUBECONFIG so hasKubeconfig() returns false.
  vi.stubEnv("KUBECONFIG", "");

  mockListComposeContainers.mockResolvedValue([
    {
      Id: "abc123",
      Names: ["/my-service"],
      Image: "test:latest",
      State: "running",
      Status: "Up 1 hour (healthy)",
      Labels: { "com.docker.compose.service": "my-service" },
    },
  ]);

  mockInspectContainer.mockResolvedValue(null);
  mockRunOneShotGpuContainer.mockResolvedValue(null);

  mockBucketStatsCached.mockReturnValue({
    stats: {
      bucket: "test-bucket",
      objectCount: 10,
      bytesTotal: 500_000,
      bytesLast24h: 50_000,
    },
    refreshing: false,
  });

  mockMediamtxListPaths.mockResolvedValue({
    paths: [],
    warning: undefined,
  });

  mockVstListSensors.mockResolvedValue({ sensors: [], warning: undefined });
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default spy implementations.
  mockCoreV1.mockReturnValue({});
  mockWatchedNamespaces.mockReturnValue(["vst", "rtvi", "agent"]);
  mockS3Bucket.mockReturnValue("test-bucket");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Happy-path tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("collectOverviewSnapshot — happy path (k8s mode)", () => {
  it("returns a populated snapshot with an empty warnings array", async () => {
    setupK8sHappyPath();

    const result: OverviewResult = await collectOverviewSnapshot();

    expect(result.warnings).toEqual([]);
    expect(result.mode).toBe("k8s");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.takenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO string

    // Namespaces should be populated from the mock pods.
    expect(Object.keys(result.snapshot.namespaces).length).toBeGreaterThan(0);

    // S3 probe ran and populated the field.
    expect(result.snapshot.s3.objectCount).toBe(42);
    expect(result.snapshot.s3.bytesTotal).toBe(1_000_000);

    // VLM-ingestion count: cam1 is VST-registered AND has an active realtime
    // alert rule per the mock, so it counts toward ingestingCount.
    expect(result.snapshot.cameraSim.ingestingCount).toBe(1);
  });
});

describe("collectPodSummaries — happy path (k8s mode)", () => {
  it("returns pod summaries with an empty warnings array", async () => {
    setupK8sHappyPath();
    // Provide pods in each watched namespace.
    mockListAllPodsInNs.mockImplementation((_api: unknown, ns: string) =>
      Promise.resolve([makeReadyPod(`pod-${ns}`, ns)])
    );

    const result: PodsResult = await collectPodSummaries();

    expect(result.warnings).toEqual([]);
    expect(result.pods.length).toBeGreaterThan(0);

    // Every returned pod should have the required PodSummary fields.
    for (const pod of result.pods) {
      expect(pod).toHaveProperty("namespace");
      expect(pod).toHaveProperty("name");
      expect(pod).toHaveProperty("phase");
      expect(pod).toHaveProperty("ready");
      expect(pod).toHaveProperty("restarts");
      expect(pod).toHaveProperty("age");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Degraded-snapshot contract: individual probe failures
// ═══════════════════════════════════════════════════════════════════════════════

describe("collectOverviewSnapshot — degraded-snapshot contract (k8s mode)", () => {
  beforeEach(() => {
    setupK8sHappyPath();
  });

  it("K8s pod list throws → returns result with K8s warning; does not throw", async () => {
    mockListAllPodsInNs.mockRejectedValue(new Error("apiserver unreachable"));

    const result = await collectOverviewSnapshot();

    // Must never throw.
    expect(result).toBeDefined();

    // At least one warning must mention the K8s failure.
    const k8sWarning = result.warnings.find(
      (w) => w.includes("pod list") || w.includes("K8s") || w.includes("apiserver")
    );
    expect(k8sWarning).toBeDefined();

    // The snapshot must still be a valid (possibly empty) shape.
    expect(result.snapshot.takenAt).toBeDefined();
    expect(result.snapshot.namespaces).toBeDefined();
    expect(typeof result.snapshot.namespaces).toBe("object");
  });

  it("S3 probe throws → returns result with S3 warning, s3 fields are zero/default", async () => {
    mockBucketStatsCached.mockImplementation(() => {
      throw new Error("s3 boom");
    });

    const result = await collectOverviewSnapshot();

    expect(result).toBeDefined();
    const s3Warning = result.warnings.find((w) => w.toLowerCase().includes("s3"));
    expect(s3Warning).toBeDefined();

    // Matching the formatted text, not just the letters "s3": the warning has
    // to be the one the S3 branch writes, carrying the thrown error through
    // describeS3Error. A warning produced by that formatting step itself
    // failing also contains "s3", and is what this test used to accept.
    expect(s3Warning).toContain("S3 stats failed:");
    expect(s3Warning).toContain("described:");
    expect(s3Warning).toContain("s3 boom");

    // S3 fields should fall back to degraded values.
    expect(result.snapshot.s3.objectCount).toBe(0);
    expect(result.snapshot.s3.bytesTotal).toBe(0);
  });

  it("Kafka admin throws → returns result with Kafka warning, topics get null (unknown) depth", async () => {
    const failingAdmin = {
      connect: vi.fn().mockRejectedValue(new Error("kafka unreachable")),
      disconnect: vi.fn().mockResolvedValue(undefined),
      fetchTopicOffsets: vi.fn(),
    };
    mockGetKafka.mockReturnValue({
      status: "connected",
      instance: { admin: vi.fn(() => failingAdmin) },
    });

    const result = await collectOverviewSnapshot();

    expect(result).toBeDefined();
    const kafkaWarning = result.warnings.find((w) =>
      w.toLowerCase().includes("kafka")
    );
    expect(kafkaWarning).toBeDefined();

    // Topics should still be present, but with null depth — unknown, never a
    // false 0 that would render a misleading "OK" while the broker is down.
    for (const entry of Object.values(result.snapshot.kafka)) {
      expect(entry.retainedMsgs).toBeNull();
    }
  });

  it("VST sensor list unreachable → camera-sim reads unreachable with a warning", async () => {
    // vstListSensors returns a warning (does not throw) when VST is unreachable;
    // the collector surfaces it and marks cameraSim degraded.
    mockVstListSensors.mockResolvedValue({ sensors: [], warning: "VST sensor-ms unreachable: timeout" });

    const result = await collectOverviewSnapshot();

    expect(result).toBeDefined();
    const camWarning = result.warnings.find((w) => w.toLowerCase().includes("vst"));
    expect(camWarning).toBeDefined();

    // cameraSim should fall back to degraded state.
    expect(result.snapshot.cameraSim.instanceState).toBe("unreachable");
    expect(result.snapshot.cameraSim.pathsReady).toBe(0);
    expect(result.snapshot.cameraSim.pathsTotal).toBe(0);
  });

  it("alert-bridge unreachable → ingestingCount omitted (undefined), not a false 0", async () => {
    mockListIngestingCameras.mockResolvedValue({
      ingesting: new Set<string>(),
      warning: "alert-bridge unreachable: timeout",
    });

    const result = await collectOverviewSnapshot();

    expect(result).toBeDefined();
    const ingestWarning = result.warnings.find((w) => w.toLowerCase().includes("alert-bridge"));
    expect(ingestWarning).toBeDefined();
    expect(result.snapshot.cameraSim.ingestingCount).toBeUndefined();
  });

  it("ALL probes throw → still resolves; warnings has multiple entries; never throws", async () => {
    // K8s pods — all namespaces fail.
    mockListAllPodsInNs.mockRejectedValue(new Error("k8s down"));

    // Prometheus — fail all GPU queries.
    mockPromQuery.mockRejectedValue(new Error("prometheus down"));

    // Kafka — connect fails.
    const failingAdmin = {
      connect: vi.fn().mockRejectedValue(new Error("kafka down")),
      disconnect: vi.fn().mockResolvedValue(undefined),
      fetchTopicOffsets: vi.fn(),
    };
    mockGetKafka.mockReturnValue({
      status: "connected",
      instance: { admin: vi.fn(() => failingAdmin) },
    });

    // S3 fails.
    mockBucketStatsCached.mockImplementation(() => {
      throw new Error("s3 down");
    });

    // mediamtx fails.
    mockMediamtxListPaths.mockRejectedValue(new Error("mediamtx down"));

    // Must resolve — not reject.
    let result: OverviewResult | undefined;
    await expect(
      collectOverviewSnapshot().then((r) => {
        result = r;
        return r;
      })
    ).resolves.toBeDefined();

    expect(result).toBeDefined();
    expect(result!.warnings.length).toBeGreaterThan(0);

    // The snapshot must still conform to the OverviewSnapshot shape.
    const snap = result!.snapshot;
    expect(snap.takenAt).toBeDefined();
    expect(snap.namespaces).toBeDefined();
    expect(snap.nim).toBeDefined();
    expect(snap.gpus).toBeDefined();
    expect(snap.kafka).toBeDefined();
    expect(snap.s3).toBeDefined();
    expect(snap.cameraSim).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// collectPodSummaries — degraded contract
// ═══════════════════════════════════════════════════════════════════════════════

describe("collectPodSummaries — degraded-snapshot contract (k8s mode)", () => {
  beforeEach(() => {
    setupK8sHappyPath();
  });

  it("one namespace fails → warning emitted for that ns; other pods still returned", async () => {
    // Three watched namespaces: vst OK, rtvi throws, agent OK.
    mockWatchedNamespaces.mockReturnValue(["vst", "rtvi", "agent"]);
    mockListAllPodsInNs.mockImplementation((_api: unknown, ns: string) => {
      if (ns === "rtvi") return Promise.reject(new Error("rtvi ns gone"));
      return Promise.resolve([makeReadyPod(`pod-${ns}`, ns)]);
    });

    const result = await collectPodSummaries();

    expect(result).toBeDefined();
    // Warning for rtvi.
    const rtviWarning = result.warnings.find((w) => w.includes("rtvi"));
    expect(rtviWarning).toBeDefined();
    // Pods from healthy namespaces are still present.
    expect(result.pods.some((p) => p.namespace === "vst")).toBe(true);
    expect(result.pods.some((p) => p.namespace === "agent")).toBe(true);
  });

  it("ALL namespace calls throw → resolves with empty pods + warnings; does not throw", async () => {
    mockListAllPodsInNs.mockRejectedValue(new Error("apiserver gone"));

    const result = await collectPodSummaries();

    expect(result).toBeDefined();
    expect(result.pods).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Optional: nsFilter parameter
// ═══════════════════════════════════════════════════════════════════════════════

describe("collectPodSummaries — nsFilter", () => {
  beforeEach(() => {
    setupK8sHappyPath();
  });

  it("nsFilter='vst' restricts queries to the vst namespace only", async () => {
    mockListAllPodsInNs.mockImplementation((_api: unknown, ns: string) =>
      Promise.resolve([makeReadyPod(`pod-${ns}`, ns)])
    );

    const result = await collectPodSummaries("vst");

    expect(result.warnings).toEqual([]);
    // Only pods from the vst namespace should be returned.
    expect(result.pods.every((p) => p.namespace === "vst")).toBe(true);
    // listAllPodsInNs should have been called exactly once, for vst.
    const namespacesQueried = mockListAllPodsInNs.mock.calls.map(
      (call) => call[1]
    );
    expect(namespacesQueried).toEqual(["vst"]);
  });

  it("nsFilter='all' falls back to all watched namespaces", async () => {
    mockWatchedNamespaces.mockReturnValue(["vst", "rtvi"]);
    mockListAllPodsInNs.mockImplementation((_api: unknown, ns: string) =>
      Promise.resolve([makeReadyPod(`pod-${ns}`, ns)])
    );

    const result = await collectPodSummaries("all");

    expect(result.warnings).toEqual([]);
    const namespacesQueried = mockListAllPodsInNs.mock.calls.map(
      (call) => call[1]
    );
    expect(namespacesQueried).toContain("vst");
    expect(namespacesQueried).toContain("rtvi");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Optional: pod-summary aggregation
// ═══════════════════════════════════════════════════════════════════════════════

describe("collectPodSummaries — phase counts", () => {
  beforeEach(() => {
    setupK8sHappyPath();
    mockWatchedNamespaces.mockReturnValue(["vst"]);
  });

  it("correctly classifies Running (ready), and Failed pods", async () => {
    const pods = [
      makeReadyPod("running-pod", "vst"),
      makeFailedPod("failed-pod", "vst"),
    ];
    mockListAllPodsInNs.mockResolvedValue(pods);

    const result = await collectPodSummaries();

    const running = result.pods.filter((p) => p.phase === "Running");
    const failed = result.pods.filter((p) => p.phase === "Failed");

    expect(running.length).toBe(1);
    expect(running[0].ready).toBe(true);
    expect(failed.length).toBe(1);
    expect(failed[0].ready).toBe(false);
    expect(failed[0].restarts).toBe(2);
  });

  it("counts a Succeeded pod toward ready so a completed Job doesn't read as WARN", async () => {
    // One Running+Ready pod + one completed Job (Succeeded, no Ready cond).
    // The namespace must show ready === total, not total-1.
    mockListAllPodsInNs.mockResolvedValue([
      makeReadyPod("vss-agent", "vst"),
      makeSucceededPod("aq", "vst"),
    ]);

    const { snapshot } = await collectOverviewSnapshot();

    expect(snapshot.namespaces["vst"]).toEqual({ total: 2, ready: 2, failed: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Docker mode — basic contract
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Todos ────────────────────────────────────────────────────────────────────
// The following cases have high mock surface area and are left as TODOs
// with documented reasons.

it.todo(
  "Redis probe: collectOverviewSnapshot references Redis via @/lib/redis " +
    "but the k8s-mode collector does NOT call getRedis() directly — Redis is " +
    "used by routes (e.g. /incidents) not the overview collector. " +
    "Skipped — no Redis probe in the current collector implementation."
);

it.todo(
  "Prometheus GPU data: full happy-path with real DCGM metric shapes " +
    "(gpuIndexMap population, utilMem calculation). " +
    "Skipped — requires stubbing 5 independent promQuery calls with labelled " +
    "metric payloads; correctness of parseFloat arithmetic is better covered " +
    "by a pure-unit test of a hypothetical exported helper."
);
