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

import { s3Stats, s3IncompleteMultipartUploads } from "@/lib/aws";

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
