import { describe, it, expect, vi, beforeEach } from "vitest";

// evidence.ts memoizes a single S3Client instance (module-level `_client`),
// built via `makeS3Client()` from "@/lib/s3" — mock that factory so every
// call to `client()` returns the same stub with a controllable `send`.
const send = vi.fn();
vi.mock("@/lib/s3", () => ({
  makeS3Client: vi.fn(() => ({ send })),
}));

import { verifyImmutable } from "./evidence";

describe("verifyImmutable", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("reports deleted when the delete succeeds — the lock is broken", async () => {
    send.mockResolvedValueOnce({});
    const result = await verifyImmutable("cam-1/2026-07-08T00-00-00.mp4", "v1");
    expect(result).toEqual({ status: "deleted" });
  });

  it("reports immutable when the delete is refused with name AccessDenied", async () => {
    const err = Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
    send.mockRejectedValueOnce(err);
    const result = await verifyImmutable("cam-1/2026-07-08T00-00-00.mp4", "v1");
    expect(result.status).toBe("immutable");
    expect(result.error).toContain("AccessDenied");
  });

  it("reports immutable when the delete is refused with a 403 http status", async () => {
    const err = { name: "SomeOtherErrorName", message: "denied", $metadata: { httpStatusCode: 403 } };
    send.mockRejectedValueOnce(err);
    const result = await verifyImmutable("cam-1/2026-07-08T00-00-00.mp4", "v1");
    expect(result.status).toBe("immutable");
  });

  it("reports inconclusive on a generic/unrelated error — never a false immutable", async () => {
    send.mockRejectedValueOnce(new Error("boom"));
    const result = await verifyImmutable("cam-1/2026-07-08T00-00-00.mp4", "v1");
    expect(result.status).toBe("inconclusive");
    expect(result.error).toContain("boom");
  });

  it("reports inconclusive on NoSuchKey/NoSuchVersion — not an access denial", async () => {
    const err = Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    send.mockRejectedValueOnce(err);
    const result = await verifyImmutable("cam-1/2026-07-08T00-00-00.mp4", "v1");
    expect(result.status).toBe("inconclusive");
  });
});
