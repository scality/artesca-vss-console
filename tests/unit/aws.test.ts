import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock spies ────────────────────────────────────────────────────────
//
// vi.mock() factories are hoisted to the top of the file by vitest's transform,
// BEFORE any `const` declarations in this module are initialised. We therefore
// create the spies with vi.hoisted() so they exist by the time the factory runs.

const { mockS3Send, mockMakeS3Client } = vi.hoisted(() => {
  const mockS3Send = vi.fn();
  const mockMakeS3Client = vi.fn().mockReturnValue({ send: mockS3Send });
  return { mockS3Send, mockMakeS3Client };
});

// ─── S3 mock ───────────────────────────────────────────────────────────────────
//
// aws.ts calls makeS3Client() from @/lib/s3 rather than constructing S3Client
// directly, so we mock that helper module.

vi.mock("@/lib/s3", () => ({
  makeS3Client: mockMakeS3Client,
  // aws.ts uses s3Region() only as the client-cache key; a fixed value keeps
  // every test in this file sharing one cached client.
  s3Region: () => "us-west-2",
}));

// ─── SDK command classes ────────────────────────────────────────────────────────
// We still use the real command classes (only the clients are mocked) so we
// can assert `expect(cmd).toBeInstanceOf(...)`.

import { ListObjectsV2Command, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";

// ─── Module under test ─────────────────────────────────────────────────────────

import { s3Stats, s3SubstrateStats, s3IncompleteMultipartUploads } from "@/lib/aws";
import { BUCKET_SCAN_PAGE_LIMIT, BUCKET_SCAN_PAGE_SIZE } from "@/lib/storage/bucket-scan";

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply default implementations after clearAllMocks resets them.
  mockMakeS3Client.mockReturnValue({ send: mockS3Send });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── s3Stats ──────────────────────────────────────────────────────────────────

describe("s3Stats", () => {
  it("single page: aggregates objectCount + bytesTotal correctly", async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [{ Size: 1024 }, { Size: 2048 }, { Size: 512 }],
      NextContinuationToken: undefined,
    });

    const result = await s3Stats("my-bucket");

    expect(result.bucket).toBe("my-bucket");
    expect(result.objectCount).toBe(3);
    expect(result.bytesTotal).toBe(3584);
    expect(result.truncated).toBeFalsy();
  });

  it("multi-page: walks all pages and aggregates totals", async () => {
    mockS3Send
      .mockResolvedValueOnce({
        Contents: [{ Size: 100 }, { Size: 200 }],
        NextContinuationToken: "token-page-2",
      })
      .mockResolvedValueOnce({
        Contents: [{ Size: 300 }],
        NextContinuationToken: undefined,
      });

    const result = await s3Stats("paged-bucket");

    expect(result.objectCount).toBe(3);
    expect(result.bytesTotal).toBe(600);
    expect(result.truncated).toBeFalsy();

    // Confirm the second call passed the continuation token.
    const secondCall = mockS3Send.mock.calls[1][0];
    expect(secondCall).toBeInstanceOf(ListObjectsV2Command);
    expect(secondCall.input.ContinuationToken).toBe("token-page-2");
  });

  it("short walk (3 pages): truncated is NOT set", async () => {
    mockS3Send
      .mockResolvedValueOnce({
        Contents: [{ Size: 10 }],
        NextContinuationToken: "tok-2",
      })
      .mockResolvedValueOnce({
        Contents: [{ Size: 20 }],
        NextContinuationToken: "tok-3",
      })
      .mockResolvedValueOnce({
        Contents: [{ Size: 30 }],
        NextContinuationToken: undefined,
      });

    const result = await s3Stats("short-walk-bucket");

    expect(result.objectCount).toBe(3);
    expect(result.bytesTotal).toBe(60);
    expect(result.truncated).toBeFalsy();
  });

  it("empty bucket: objectCount=0, bytesTotal=0, no truncated flag", async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: undefined,
      NextContinuationToken: undefined,
    });

    const result = await s3Stats("empty-bucket");

    expect(result.objectCount).toBe(0);
    expect(result.bytesTotal).toBe(0);
    expect(result.truncated).toBeFalsy();
  });

  it("objects missing Size field default to 0 bytes", async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [{ Size: undefined }, { Size: 500 }],
      NextContinuationToken: undefined,
    });

    const result = await s3Stats("partial-sizes-bucket");

    expect(result.objectCount).toBe(2);
    expect(result.bytesTotal).toBe(500);
  });

  it("passes the Bucket name into ListObjectsV2Command", async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [],
      NextContinuationToken: undefined,
    });

    await s3Stats("specific-bucket");

    const cmd = mockS3Send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(ListObjectsV2Command);
    expect(cmd.input.Bucket).toBe("specific-bucket");
  });
});

// ─── s3SubstrateStats ─────────────────────────────────────────────────────────
//
// The full-bucket walk behind every recordings total the console shows (overview
// KPI card, kiosk tile, topology node, /storage, /diagnostics). The defects it
// guards against: a total read from one page, or a capped walk, presented as the
// bucket; and "latest objects" taken from key order, which for
// `<sensor-uuid>/YYYY/MM/DD/HH/<epoch>.mkv` keys is sensor-UUID order, not time.

describe("s3SubstrateStats", () => {
  it("walks every page with its continuation token and totals the whole bucket", async () => {
    mockS3Send
      .mockResolvedValueOnce({
        Contents: [{ Key: "a/1", Size: 100 }, { Key: "a/2", Size: 200 }],
        NextContinuationToken: "t2",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "b/1", Size: 300 }],
        NextContinuationToken: "t3",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "c/1", Size: 400 }],
        NextContinuationToken: undefined,
      });

    const result = await s3SubstrateStats("recordings");

    expect(mockS3Send).toHaveBeenCalledTimes(3);
    expect(result.objectCount).toBe(4);
    expect(result.bytesTotal).toBe(1000);
    expect(result.truncated).toBeUndefined();
    const inputs = mockS3Send.mock.calls.map((c) => c[0].input);
    expect(inputs.map((i) => i.ContinuationToken)).toEqual([undefined, "t2", "t3"]);
    expect(inputs.every((i) => i.MaxKeys === BUCKET_SCAN_PAGE_SIZE)).toBe(true);
  });

  it("picks the newest objects by LastModified across pages, not by key order", async () => {
    const now = Date.now();
    const at = (minsAgo: number) => new Date(now - minsAgo * 60_000);
    // Page 1 holds the sensor whose UUID sorts first and is the one still
    // recording; the last page holds a sensor that stopped long ago. Key order
    // would call the last page "latest".
    mockS3Send
      .mockResolvedValueOnce({
        Contents: [
          { Key: "01live/2026/10/08/9/1.mkv", Size: 1, LastModified: at(1) },
          { Key: "01live/2026/10/08/9/2.mkv", Size: 1, LastModified: at(0) },
        ],
        NextContinuationToken: "t2",
      })
      .mockResolvedValueOnce({
        Contents: [
          { Key: "ffdead/2026/09/01/23/1.mkv", Size: 1, LastModified: at(60 * 24 * 37) },
          { Key: "ffdead/2026/09/01/23/2.mkv", Size: 1, LastModified: at(60 * 24 * 37 - 1) },
        ],
        NextContinuationToken: undefined,
      });

    const result = await s3SubstrateStats("recordings", 2);

    expect(result.recent.map((r) => r.key)).toEqual([
      "01live/2026/10/08/9/2.mkv",
      "01live/2026/10/08/9/1.mkv",
    ]);
  });

  it("stops at the page cap and reports the totals as truncated", async () => {
    mockS3Send.mockImplementation(async () => ({
      Contents: [{ Key: "k", Size: 1 }],
      NextContinuationToken: "more",
    }));

    const result = await s3SubstrateStats("runaway");

    expect(mockS3Send).toHaveBeenCalledTimes(BUCKET_SCAN_PAGE_LIMIT);
    expect(result.objectCount).toBe(BUCKET_SCAN_PAGE_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it("a bucket that ends exactly on the last allowed page is complete, not truncated", async () => {
    let call = 0;
    mockS3Send.mockImplementation(async () => {
      call++;
      return {
        Contents: [{ Key: `k${call}`, Size: 1 }],
        NextContinuationToken: call < BUCKET_SCAN_PAGE_LIMIT ? `t${call}` : undefined,
      };
    });

    const result = await s3SubstrateStats("exact");

    expect(result.objectCount).toBe(BUCKET_SCAN_PAGE_LIMIT);
    expect(result.truncated).toBeUndefined();
  });
});

// ─── s3IncompleteMultipartUploads ───────────────────────────────────────────────
//
// Regression guard for the 2026-09-10 pyramid-showroom incident: the recordings
// bucket carried 5,664 incomplete multipart uploads, invisible to ListObjectsV2
// (s3Stats above), aborted by hand.

describe("s3IncompleteMultipartUploads", () => {
  it("single page: counts the uploads and reports not truncated", async () => {
    mockS3Send.mockResolvedValueOnce({
      Uploads: [{ Key: "a", UploadId: "1" }, { Key: "b", UploadId: "2" }],
      IsTruncated: false,
    });

    const result = await s3IncompleteMultipartUploads("recordings-bucket");

    expect(result).toEqual({ count: 2, truncated: false });
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it("multi-page: walks KeyMarker/UploadIdMarker until IsTruncated is false", async () => {
    mockS3Send
      .mockResolvedValueOnce({
        Uploads: [{ Key: "k1", UploadId: "1" }, { Key: "k2", UploadId: "2" }],
        IsTruncated: true,
        NextKeyMarker: "k2",
        NextUploadIdMarker: "2",
      })
      .mockResolvedValueOnce({
        Uploads: [{ Key: "k3", UploadId: "3" }],
        IsTruncated: false,
      });

    const result = await s3IncompleteMultipartUploads("paged-bucket");

    expect(result).toEqual({ count: 3, truncated: false });
    const secondCall = mockS3Send.mock.calls[1][0];
    expect(secondCall).toBeInstanceOf(ListMultipartUploadsCommand);
    expect(secondCall.input.KeyMarker).toBe("k2");
    expect(secondCall.input.UploadIdMarker).toBe("2");
  });

  it("caps the walk at 10 pages and reports truncated rather than looping forever", async () => {
    mockS3Send.mockImplementation(async () => ({
      Uploads: [{ Key: "k", UploadId: "u" }],
      IsTruncated: true,
      NextKeyMarker: "k",
      NextUploadIdMarker: "u",
    }));

    const result = await s3IncompleteMultipartUploads("runaway-bucket");

    expect(mockS3Send).toHaveBeenCalledTimes(10);
    expect(result).toEqual({ count: 10, truncated: true });
  });

  it("empty bucket: count 0, not truncated", async () => {
    mockS3Send.mockResolvedValueOnce({ Uploads: [], IsTruncated: false });

    const result = await s3IncompleteMultipartUploads("empty-bucket");

    expect(result).toEqual({ count: 0, truncated: false });
  });

  it("passes the Bucket name into ListMultipartUploadsCommand", async () => {
    mockS3Send.mockResolvedValueOnce({ Uploads: [], IsTruncated: false });

    await s3IncompleteMultipartUploads("specific-bucket");

    const cmd = mockS3Send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(ListMultipartUploadsCommand);
    expect(cmd.input.Bucket).toBe("specific-bucket");
  });
});
