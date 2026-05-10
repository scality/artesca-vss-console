import { describe, it, expect, vi } from "vitest";

// request-context uses "server-only" — stub it before importing (also done globally in setup.ts)
vi.mock("server-only", () => ({}));

import {
  runWithRequestContext,
  getRequestContext,
  getRequestId,
} from "@/lib/request-context";

describe("request-context", () => {
  it("makes getRequestContext() return the ctx inside the run", () => {
    runWithRequestContext({ reqId: "abc" }, () => {
      expect(getRequestContext()).toEqual({ reqId: "abc" });
    });
  });

  it("returns undefined outside any runWithRequestContext", () => {
    // Ensure we are outside any context
    expect(getRequestContext()).toBeUndefined();
  });

  it("nested runs override the outer context", () => {
    runWithRequestContext({ reqId: "outer" }, () => {
      expect(getRequestId()).toBe("outer");
      runWithRequestContext({ reqId: "inner" }, () => {
        expect(getRequestId()).toBe("inner");
      });
      // Outer context is restored after nested run exits
      expect(getRequestId()).toBe("outer");
    });
  });

  it("async propagation: reqId is visible after an await", async () => {
    const result = await runWithRequestContext({ reqId: "x" }, async () => {
      await Promise.resolve();
      return getRequestId();
    });
    expect(result).toBe("x");
  });

  it("concurrent contexts do not bleed into each other", async () => {
    const results = await Promise.all([
      runWithRequestContext({ reqId: "ctx-1" }, async () => {
        await Promise.resolve();
        return getRequestId();
      }),
      runWithRequestContext({ reqId: "ctx-2" }, async () => {
        await Promise.resolve();
        return getRequestId();
      }),
    ]);
    expect(results).toContain("ctx-1");
    expect(results).toContain("ctx-2");
    // Each slot should see its own id, not the other one
    expect(results[0]).toBe("ctx-1");
    expect(results[1]).toBe("ctx-2");
  });

  it("getRequestId() is undefined outside any run", () => {
    expect(getRequestId()).toBeUndefined();
  });
});
