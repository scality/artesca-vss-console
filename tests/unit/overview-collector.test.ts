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
  mockS3Stats,
  mockGetKafka,
  mockPromQuery,
  mockMediamtxListPaths,
  mockListComposeContainers,
  mockInspectContainer,
  mockRunOneShotGpuContainer,
  mockS3Bucket,
} = vi.hoisted(() => {
  const mockListAllPodsInNs = vi.fn();
  const mockCoreV1 = vi.fn(() => ({}));
  const mockWatchedNamespaces = vi.fn(() => ["vst", "rtvi", "agent"]);

  const mockS3Stats = vi.fn();
  const mockGetKafka = vi.fn();
  const mockPromQuery = vi.fn();
  const mockMediamtxListPaths = vi.fn();
  const mockListComposeContainers = vi.fn();
  const mockInspectContainer = vi.fn();
  const mockRunOneShotGpuContainer = vi.fn();
  const mockS3Bucket = vi.fn(() => "test-bucket");

  return {
    mockListAllPodsInNs,
    mockCoreV1,
    mockWatchedNamespaces,
    mockS3Stats,
    mockGetKafka,
    mockPromQuery,
    mockMediamtxListPaths,
    mockListComposeContainers,
    mockInspectContainer,
    mockRunOneShotGpuContainer,
    mockS3Bucket,
  };
});

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("@/lib/k8s", () => ({
  coreV1: mockCoreV1,
  appsV1: vi.fn(() => ({})),
  watchedNamespaces: mockWatchedNamespaces,
  listAllPodsInNs: mockListAllPodsInNs,
}));

vi.mock("@/lib/aws", () => ({
  s3Stats: mockS3Stats,
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

vi.mock("@/lib/helpers/docker-sock", () => ({
  listComposeContainers: mockListComposeContainers,
  inspectContainer: mockInspectContainer,
  runOneShotGpuContainer: mockRunOneShotGpuContainer,
  DOCKER_TUNING_DIR: "/tmp/docker-tuning",
}));

vi.mock("@/lib/s3", () => ({
  s3BucketForRecordings: mockS3Bucket,
  s3BucketForAlertClips: vi.fn(() => "nvidia-vss-alert-clips"),
  s3KeyForAlertClip: vi.fn(),
  makeS3Client: vi.fn(),
  s3Endpoint: vi.fn(() => undefined),
  s3Region: vi.fn(() => "us-west-2"),
  isAwsNativeEndpoint: vi.fn(() => true),
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

  // S3 — successful.
  mockS3Stats.mockResolvedValue({
    bucket: "test-bucket",
    objectCount: 42,
    bytesTotal: 1_000_000,
  });

  // Camera-sim / mediamtx — working.
  mockMediamtxListPaths.mockResolvedValue({
    paths: [
      { name: "cam1", ready: true },
      { name: "cam1-h264", ready: true }, // should be filtered out
    ],
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

  mockS3Stats.mockResolvedValue({
    bucket: "test-bucket",
    objectCount: 10,
    bytesTotal: 500_000,
  });

  mockMediamtxListPaths.mockResolvedValue({
    paths: [],
    warning: undefined,
  });
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
    mockS3Stats.mockRejectedValue(new Error("s3 boom"));

    const result = await collectOverviewSnapshot();

    expect(result).toBeDefined();
    const s3Warning = result.warnings.find((w) => w.toLowerCase().includes("s3"));
    expect(s3Warning).toBeDefined();

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

  it("mediamtx / camera-sim probe throws → returns result with camera-sim warning", async () => {
    mockMediamtxListPaths.mockRejectedValue(new Error("mediamtx timeout"));

    const result = await collectOverviewSnapshot();

    expect(result).toBeDefined();
    const camWarning = result.warnings.find(
      (w) => w.toLowerCase().includes("camera") || w.toLowerCase().includes("mediamtx") || w.toLowerCase().includes("cam")
    );
    expect(camWarning).toBeDefined();

    // cameraSim should fall back to degraded state.
    expect(result.snapshot.cameraSim.instanceState).toBe("unreachable");
    expect(result.snapshot.cameraSim.pathsReady).toBe(0);
    expect(result.snapshot.cameraSim.pathsTotal).toBe(0);
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
    mockS3Stats.mockRejectedValue(new Error("s3 down"));

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
});

// ═══════════════════════════════════════════════════════════════════════════════
// Docker mode — basic contract
// ═══════════════════════════════════════════════════════════════════════════════

describe("collectOverviewSnapshot — docker mode", () => {
  it("happy path: returns populated snapshot from compose containers; no warnings", async () => {
    setupDockerHappyPath();
    // Provide S3 creds so the s3 probe fires.
    vi.stubEnv("OBJECTSTORE_ACCESS_KEY_ID", "ak");

    const result = await collectOverviewSnapshot();

    expect(result.mode).toBe("docker");
    expect(result.warnings).toEqual([]);
    expect(result.snapshot.namespaces["my-service"]).toBeDefined();
    expect(result.snapshot.namespaces["my-service"].total).toBe(1);
    expect(result.snapshot.namespaces["my-service"].ready).toBe(1);
  });

  it("docker.sock throws → warning emitted; result still returned", async () => {
    setupDockerHappyPath();
    mockListComposeContainers.mockRejectedValue(new Error("socket gone"));

    const result = await collectOverviewSnapshot();

    expect(result).toBeDefined();
    const dockerWarning = result.warnings.find(
      (w) => w.toLowerCase().includes("docker") || w.toLowerCase().includes("socket") || w.toLowerCase().includes("container")
    );
    expect(dockerWarning).toBeDefined();
  });
});

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
