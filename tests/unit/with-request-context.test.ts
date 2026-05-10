import { describe, it, expect, vi, beforeEach } from "vitest";

// next/headers is globally mocked in setup.ts — we override per test below.
// server-only is globally mocked in setup.ts.

import { headers } from "next/headers";
import { runWithRequestContext, getRequestId } from "@/lib/request-context";
import { withRequestContext } from "@/lib/with-request-context";

// Helper: build a Headers-like object with a .get(name) method.
function makeHeaders(map: Record<string, string>) {
  return {
    get: (name: string) => map[name] ?? null,
  };
}

describe("withRequestContext", () => {
  beforeEach(() => {
    vi.mocked(headers).mockReset();
  });

  it("reads x-request-id from request headers and establishes ALS context", async () => {
    vi.mocked(headers).mockResolvedValue(makeHeaders({ "x-request-id": "req-abc" }) as ReturnType<typeof headers> extends Promise<infer T> ? T : never);

    let capturedReqId: string | undefined;
    const handler = withRequestContext(async () => {
      capturedReqId = getRequestId();
      return "ok";
    });

    const result = await handler();
    expect(result).toBe("ok");
    expect(capturedReqId).toBe("req-abc");
  });

  it("generates a UUID when x-request-id header is absent", async () => {
    vi.mocked(headers).mockResolvedValue(makeHeaders({}) as ReturnType<typeof headers> extends Promise<infer T> ? T : never);

    let capturedReqId: string | undefined;
    const handler = withRequestContext(async () => {
      capturedReqId = getRequestId();
      return "ok";
    });

    await handler();
    expect(capturedReqId).toBeDefined();
    // UUID v4 pattern
    expect(capturedReqId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("generates a UUID when headers() throws", async () => {
    vi.mocked(headers).mockRejectedValue(new Error("headers() unavailable"));

    let capturedReqId: string | undefined;
    const handler = withRequestContext(async () => {
      capturedReqId = getRequestId();
      return "ok";
    });

    await handler();
    expect(capturedReqId).toBeDefined();
    expect(capturedReqId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("passes arguments through to the handler", async () => {
    vi.mocked(headers).mockResolvedValue(makeHeaders({ "x-request-id": "req-pass" }) as ReturnType<typeof headers> extends Promise<infer T> ? T : never);

    const handler = withRequestContext(async (a: number, b: string) => {
      return `${a}-${b}`;
    });

    const result = await handler(42, "hello");
    expect(result).toBe("42-hello");
  });

  it("ALS context is not visible outside the handler", async () => {
    vi.mocked(headers).mockResolvedValue(makeHeaders({ "x-request-id": "req-outside" }) as ReturnType<typeof headers> extends Promise<infer T> ? T : never);

    const handler = withRequestContext(async () => "done");
    await handler();

    // After the handler resolves, ALS context should be gone
    expect(getRequestId()).toBeUndefined();
  });

  it("log calls inside the handler see the reqId from context", async () => {
    // Verify integration: the handler establishes ALS context, which the logger can read.
    vi.mocked(headers).mockResolvedValue(makeHeaders({ "x-request-id": "log-req-id" }) as ReturnType<typeof headers> extends Promise<infer T> ? T : never);

    let capturedReqId: string | undefined;
    const handler = withRequestContext(async () => {
      capturedReqId = getRequestId();
      return "done";
    });

    await handler();
    expect(capturedReqId).toBe("log-req-id");
  });
});
