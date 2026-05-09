/**
 * Unit tests for GET /api/health/ready
 *
 * Route performs a 2-second-timeout depth check on:
 *   - DB:  getDb().prepare("SELECT 1").get()
 *   - K8s: coreV1().listNamespace({ limit: 1 })
 *
 * Each check is wrapped in Promise.race() with a setTimeout — so we control
 * outcomes by resolving or rejecting the mocked functions directly.
 * For the timeout test we use vi.useFakeTimers() to advance the clock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted spy factories ────────────────────────────────────────────────────

const { mockPrepare, mockListNamespace, mockCoreV1 } = vi.hoisted(() => {
  const mockPrepare = vi.fn(() => ({ get: vi.fn() }));
  const mockListNamespace = vi.fn();
  const mockCoreV1 = vi.fn(() => ({ listNamespace: mockListNamespace }));

  return { mockPrepare, mockListNamespace, mockCoreV1 };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({ prepare: mockPrepare })),
}));

vi.mock("@/lib/k8s", () => ({
  coreV1: mockCoreV1,
}));

// ── Module under test ────────────────────────────────────────────────────────

import { GET } from "@/app/api/health/ready/route";

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy path: both succeed.
  mockPrepare.mockReturnValue({ get: vi.fn().mockReturnValue({ "1": 1 }) });
  mockListNamespace.mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/health/ready", () => {
  it("happy path: DB and K8s succeed → 200 with ok:true and both checks 'ok'", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe("ok");
    expect(body.checks.k8s).toBe("ok");
    expect(body.errors).toBeUndefined();
    expect(body.ts).toBeDefined();
  });

  it("DB fails: returns 503, checks.db is 'fail', errors includes the db message", async () => {
    mockPrepare.mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    });

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("fail");
    expect(body.checks.k8s).toBe("ok");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.some((e: string) => e.includes("db"))).toBe(true);
  });

  it("K8s fails: returns 503, checks.k8s is 'fail', errors includes the k8s message", async () => {
    mockListNamespace.mockRejectedValue(new Error("connection refused"));

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("ok");
    expect(body.checks.k8s).toBe("fail");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.some((e: string) => e.includes("k8s"))).toBe(true);
  });

  it("both DB and K8s fail: returns 503, both checks are 'fail', errors has two entries", async () => {
    mockPrepare.mockImplementation(() => {
      throw new Error("db gone");
    });
    mockListNamespace.mockRejectedValue(new Error("apiserver gone"));

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("fail");
    expect(body.checks.k8s).toBe("fail");
    expect(body.errors.length).toBe(2);
  });

  it("timeout: a K8s call that never resolves is reported as fail after 2s (fake timers)", async () => {
    vi.useFakeTimers();

    // DB succeeds immediately.
    mockPrepare.mockReturnValue({ get: vi.fn().mockReturnValue({ "1": 1 }) });

    // K8s never resolves — simulates a hung connection.
    mockListNamespace.mockImplementation(
      () => new Promise<void>(() => { /* never resolves */ })
    );

    // Start the GET — don't await yet; we need to advance the clock first.
    const resPromise = GET();

    // Advance past the 2s timeout declared in the route (TIMEOUT_MS = 2000).
    await vi.runAllTimersAsync();

    const res = await resPromise;

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.k8s).toBe("fail");
    expect(body.errors.some((e: string) => e.includes("timed out"))).toBe(true);
  });
});
