import { describe, it, expect } from "vitest";
import { extractK8sError } from "@/lib/errors";

// errors.ts uses duck-typing (checks code/statusCode + body.message) — no instanceof HttpError.
// We construct plain objects with the right shape.

describe("extractK8sError", () => {
  describe("ApiException-like objects (duck-typed)", () => {
    it("uses statusCode + body.message when both are present", () => {
      const err = { statusCode: 404, body: { message: "not found" } };
      expect(extractK8sError(err)).toEqual({ status: 404, message: "not found" });
    });

    it("uses code when statusCode is absent", () => {
      const err = { code: 409, body: { message: "conflict" } };
      expect(extractK8sError(err)).toEqual({ status: 409, message: "conflict" });
    });

    it("prefers code over statusCode when both present", () => {
      const err = { code: 422, statusCode: 500, body: { message: "unprocessable" } };
      expect(extractK8sError(err)).toEqual({ status: 422, message: "unprocessable" });
    });

    it("falls back to err.message when body.message is undefined", () => {
      const err = { statusCode: 503, body: {}, message: "service unavailable" };
      expect(extractK8sError(err)).toEqual({ status: 503, message: "service unavailable" });
    });

    it("falls back to default 'kubernetes error' when body.message and err.message are both absent", () => {
      const err = { statusCode: 500, body: {} };
      expect(extractK8sError(err)).toEqual({ status: 500, message: "kubernetes error" });
    });

    it("falls back to status 500 when code and statusCode are both absent", () => {
      const err = { body: { message: "oops" } };
      expect(extractK8sError(err)).toEqual({ status: 500, message: "oops" });
    });
  });

  describe("plain Error objects", () => {
    it("returns status 500 and the error message", () => {
      const err = new Error("boom");
      // Note: the code path for plain Error is only reached when the object
      // branch above doesn't match. Error IS an object, so it goes through the
      // object branch. err.message is used as the fallback message.
      const result = extractK8sError(err);
      expect(result.status).toBe(500);
      expect(result.message).toBe("boom");
    });

    it("handles Error with no message — returns empty string (??  passes through empty string)", () => {
      const err = new Error();
      const result = extractK8sError(err);
      expect(result.status).toBe(500);
      // ?? only skips null/undefined, not "". new Error().message === "", so it is returned as-is.
      expect(result.message).toBe("");
    });
  });

  describe("primitive inputs", () => {
    it("handles a string input", () => {
      const result = extractK8sError("something went wrong");
      expect(result).toEqual({ status: 500, message: "something went wrong" });
    });

    it("handles undefined input", () => {
      const result = extractK8sError(undefined);
      expect(result).toEqual({ status: 500, message: "undefined" });
    });

    it("handles null input", () => {
      // null is explicitly excluded from the object branch (err !== null check)
      const result = extractK8sError(null);
      expect(result).toEqual({ status: 500, message: "null" });
    });

    it("handles a numeric input", () => {
      const result = extractK8sError(42);
      expect(result).toEqual({ status: 500, message: "42" });
    });
  });
});
