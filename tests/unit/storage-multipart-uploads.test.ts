import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for the 2026-09-10 pyramid-showroom incident: the
 * recordings bucket carried 5,664 incomplete multipart uploads, invisible to
 * the object listing the /storage page already shows, aborted by hand. This
 * pins readMultipartUploads' fail-soft contract (a listing error must read as
 * "unknown", never as zero) and its cache.
 */

const send = vi.fn();
vi.mock("@/lib/s3", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  makeS3Client: () => ({ send }),
}));

async function readMultipartUploads(bucket: string) {
  const mod = await import("@/lib/storage-substrate");
  return mod.readMultipartUploads(bucket);
}

describe("readMultipartUploads", () => {
  beforeEach(() => {
    send.mockReset();
    vi.resetModules(); // the module caches per-bucket; a fresh module = a cold cache
  });

  it("returns the incomplete-upload count and truncated marker on the happy path", async () => {
    send.mockResolvedValueOnce({
      Uploads: [{ Key: "a", UploadId: "1" }, { Key: "b", UploadId: "2" }],
      IsTruncated: false,
    });
    const stats = await readMultipartUploads("nvidia-vss-recordings");
    expect(stats).toEqual({ count: 2, truncated: false });
  });

  it("is fail-soft: a listing error yields null, never zero", async () => {
    send.mockImplementation(() => {
      throw new Error("AccessDenied");
    });
    const stats = await readMultipartUploads("nvidia-vss-recordings");
    expect(stats).toBeNull();
  });

  it("caches a successful read so a repeat call within the TTL does not re-list", async () => {
    send.mockResolvedValueOnce({ Uploads: [{ Key: "a", UploadId: "1" }], IsTruncated: false });

    const mod = await import("@/lib/storage-substrate");
    const first = await mod.readMultipartUploads("nvidia-vss-recordings");
    const second = await mod.readMultipartUploads("nvidia-vss-recordings");

    expect(first).toEqual({ count: 1, truncated: false });
    expect(second).toEqual({ count: 1, truncated: false });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
