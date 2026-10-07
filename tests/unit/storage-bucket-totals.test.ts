import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The recordings-bucket total behind /api/storage/vst, the overview KPI card, the
 * kiosk tile and the topology node: one full paginated scan, shared and cached by
 * storage-substrate.
 *
 * /api/storage/vst used to run its own scan that stopped at 5,000 objects on a cold
 * cache (five 1,000-key pages) and reported that as the bucket — 1.7% of a
 * 300k-object bucket. These tests drive the shared scan through a mocked S3 client
 * that returns many pages, with no network.
 */

const send = vi.fn();
vi.mock("@/lib/s3", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  makeS3Client: () => ({ send }),
  s3Region: () => "us-east-1",
}));

async function freshModule() {
  vi.resetModules(); // module-level caches: a fresh module is a cold cache
  return import("@/lib/storage-substrate");
}

/** A bucket of `total` 1 MiB objects served `perPage` at a time. */
function pagedBucket(total: number, perPage: number) {
  send.mockImplementation(async (cmd: { input: { ContinuationToken?: string } }) => {
    const start = Number(cmd.input.ContinuationToken ?? 0);
    const n = Math.min(perPage, total - start);
    const next = start + n < total ? String(start + n) : undefined;
    return {
      Contents: Array.from({ length: n }, (_, i) => ({
        Key: `sensor/${start + i}.mkv`,
        Size: 1024 * 1024,
        LastModified: new Date(1_700_000_000_000 + (start + i) * 1000),
      })),
      NextContinuationToken: next,
      IsTruncated: next !== undefined,
    };
  });
}

describe("bucketStatsSettled", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("counts past 5,000 objects: the whole bucket, every page", async () => {
    pagedBucket(12_345, 1000);
    const { bucketStatsSettled } = await freshModule();

    const r = await bucketStatsSettled("nvidia-vss-recordings", 2_000);

    expect(r.stats?.objectCount).toBe(12_345);
    expect(r.stats?.bytesTotal).toBe(12_345 * 1024 * 1024);
    expect(r.stats?.truncated).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(13);
    expect(r.scannedAt).not.toBeNull();
  });

  it("answers pending, not zero objects, while a cold scan is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    send.mockImplementation(async () => {
      await gate;
      return { Contents: [{ Key: "k", Size: 1 }], NextContinuationToken: undefined };
    });
    const { bucketStatsSettled } = await freshModule();

    const r = await bucketStatsSettled("nvidia-vss-recordings", 10);

    expect(r).toEqual({ stats: null, refreshing: true, scannedAt: null });
    release();
  });

  it("answers unavailable (not refreshing) after the listing fails", async () => {
    send.mockRejectedValue(new Error("AccessDenied"));
    const { bucketStatsSettled } = await freshModule();

    await bucketStatsSettled("nvidia-vss-recordings", 1_000);
    const r = await bucketStatsSettled("nvidia-vss-recordings", 0);

    expect(r).toEqual({ stats: null, refreshing: false, scannedAt: null });
  });
});

describe("bucketTotalsState", () => {
  it("names each state a page has to render differently", async () => {
    const { bucketTotalsState } = await import("@/lib/storage/bucket-scan");
    expect(bucketTotalsState({}, false)).toBe("complete");
    expect(bucketTotalsState({ truncated: true }, true)).toBe("truncated");
    expect(bucketTotalsState(null, true)).toBe("pending");
    expect(bucketTotalsState(null, false)).toBe("unavailable");
  });
});
