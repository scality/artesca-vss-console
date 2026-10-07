import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/storage/vst — the object count on the /diagnostics storage panel.
 *
 * It used to come from the route's own scan, which on a cold cache stopped after
 * five 1,000-key pages and reported 5,000 objects for a bucket of 300k+. It now
 * reads the shared full-bucket scan, so these tests feed it a mocked S3 client
 * with many pages and check the total is the whole bucket — and that a scan still
 * running is reported as pending, not as a small number. No network: S3, VST,
 * Redis, Kubernetes and Prometheus are all mocked.
 */

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));
vi.mock("@/lib/k8s", () => ({
  runInPod: vi.fn().mockRejectedValue(new Error("no cluster in unit tests")),
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ status: "disconnected", client: null }),
}));
vi.mock("@/lib/helpers/vst", () => ({
  vstListSensors: vi.fn().mockResolvedValue({ sensors: [] }),
}));

const send = vi.fn();
vi.mock("@/lib/s3", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  makeS3Client: () => ({ send }),
  s3Region: () => "us-east-1",
}));

type ListInput = { MaxKeys?: number; ContinuationToken?: string };

/** `total` objects, 1,000 per page; `hold` blocks the full-bucket walk (not the
 *  500-key fallback sample) until released. */
function pagedBucket(total: number, hold?: Promise<void>) {
  send.mockImplementation(async (cmd: { input: ListInput }) => {
    if (hold && cmd.input.MaxKeys !== 500) await hold;
    const perPage = cmd.input.MaxKeys ?? 1000;
    const start = Number(cmd.input.ContinuationToken ?? 0);
    const n = Math.max(0, Math.min(perPage, total - start));
    const next = start + n < total ? String(start + n) : undefined;
    return {
      Contents: Array.from({ length: n }, (_, i) => ({
        Key: `sensor/2026/10/08/10/${start + i}.mkv`,
        Size: 2048,
        LastModified: new Date(Date.now() - (total - start - i) * 1000),
      })),
      NextContinuationToken: next,
      IsTruncated: next !== undefined,
    };
  });
}

async function getRoute() {
  vi.resetModules(); // the bucket-stats cache is module state: start cold
  return import("@/app/api/storage/vst/route");
}

beforeEach(() => {
  send.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no prometheus")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/storage/vst — bucket totals", () => {
  it("reports the whole bucket, past the old 5,000-object cap", async () => {
    pagedBucket(23_456);
    const { GET } = await getRoute();

    const body = await (await GET()).json();

    expect(body.objectCount).toBe(23_456);
    expect(body.bytesTotal).toBe(23_456 * 2048);
    expect(body.bucketTotalsState).toBe("complete");
    expect(body.bucketScanTruncated).toBe(false);
    const walked = send.mock.calls.filter((c) => c[0].input.MaxKeys !== 500);
    expect(walked).toHaveLength(24);
  });

  it("says pending, not a partial count, while the first scan is still running", async () => {
    let release!: () => void;
    pagedBucket(10, new Promise<void>((r) => (release = r)));
    const { GET } = await getRoute();

    const body = await (await GET()).json();
    release();

    expect(body.bucketTotalsState).toBe("pending");
    expect(body.objectCount).toBe(0);
    expect(body.putRateObjectsPerSec).toBe(0);
    expect(body.alerts.map((a: { message: string }) => a.message).join("\n")).toMatch(/Counting objects/);
    expect(body.alerts.map((a: { message: string }) => a.message).join("\n")).not.toMatch(/No recordings/);
  }, 10_000);
});
