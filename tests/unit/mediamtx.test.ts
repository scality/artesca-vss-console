/**
 * Unit tests for src/lib/helpers/mediamtx.ts
 *
 * Covers:
 *  - mediamtxListPaths(): happy path (items array), bare-array fallback shape,
 *    HTTP error, network failure.
 *  - mediamtxPathStatus(): happy path, 404 (missing path), network failure.
 *
 * Mocking strategy: vi.stubGlobal("fetch", vi.fn()) — intercepts every fetch
 * call in the module under test.  cluster-refs is mocked to a test URL so no
 * process.env wiring is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── cluster-refs mock ───────────────────────────────────────────────────────

vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    mediamtx: {
      apiUrl: "http://mediamtx-test:9997",
    },
  },
}));

// ─── Module under test (imported after mocks) ────────────────────────────────

import {
  mediamtxListPaths,
  mediamtxPathStatus,
  MEDIAMTX_API,
} from "@/lib/helpers/mediamtx";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errResponse(status: number): Response {
  return new Response(JSON.stringify({ error: "not found" }), { status });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═════════════════════════════════════════════════════════════════════════════
// MEDIAMTX_API re-export
// ═════════════════════════════════════════════════════════════════════════════

describe("MEDIAMTX_API re-export", () => {
  it("matches the mocked cluster-refs value", () => {
    expect(MEDIAMTX_API).toBe("http://mediamtx-test:9997");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// mediamtxListPaths
// ═════════════════════════════════════════════════════════════════════════════

describe("mediamtxListPaths", () => {
  it("happy path: items wrapper shape, returns parsed paths", async () => {
    const payload = {
      items: [
        {
          name: "cam1",
          ready: true,
          readyTime: "2026-01-01T00:00:00Z",
          bytesReceived: 1024,
        },
        { name: "cam2", ready: false },
      ],
      pageCount: 1,
    };
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(payload));

    const result = await mediamtxListPaths();

    expect(result.warning).toBeUndefined();
    expect(result.paths).toHaveLength(2);
    expect(result.paths[0].name).toBe("cam1");
    expect(result.paths[0].ready).toBe(true);
    expect(result.paths[1].name).toBe("cam2");

    // Verify endpoint.
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://mediamtx-test:9997/v3/paths/list");
  });

  it("bare array shape: normalises [MediamtxPath, ...] directly", async () => {
    const payload = [
      { name: "cam3", ready: true },
      { name: "cam4", ready: false },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(payload));

    const result = await mediamtxListPaths();

    expect(result.paths).toHaveLength(2);
    expect(result.paths[0].name).toBe("cam3");
    expect(result.warning).toBeUndefined();
  });

  it("HTTP error: returns empty paths + warning, does not throw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(503));

    const result = await mediamtxListPaths();

    expect(result.paths).toEqual([]);
    expect(result.warning).toMatch(/503/);
  });

  it("network failure: returns empty paths + warning, does not throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await mediamtxListPaths();

    expect(result.paths).toEqual([]);
    expect(result.warning).toMatch(/unreachable/i);
    expect(result.warning).toMatch(/ECONNREFUSED/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// mediamtxPathStatus
// ═════════════════════════════════════════════════════════════════════════════

describe("mediamtxPathStatus", () => {
  it("happy path: returns the path object for a known path name", async () => {
    const pathObj = {
      name: "cam1",
      ready: true,
      tracks: ["H264"],
      bytesReceived: 2048,
    };
    vi.mocked(fetch).mockResolvedValueOnce(okResponse(pathObj));

    const result = await mediamtxPathStatus("cam1");

    expect(result.warning).toBeUndefined();
    expect(result.path).not.toBeNull();
    expect(result.path!.name).toBe("cam1");
    expect(result.path!.ready).toBe(true);

    // Verify URL construction.
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://mediamtx-test:9997/v3/paths/get/cam1");
  });

  it("path name is URL-encoded in the request URL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ name: "a b", ready: false })
    );

    await mediamtxPathStatus("a b");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/\/v3\/paths\/get\/a%20b$/);
  });

  it("404 (path not found): returns path:null + warning, does not throw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(404));

    const result = await mediamtxPathStatus("nonexistent");

    expect(result.path).toBeNull();
    expect(result.warning).toMatch(/404/);
    expect(result.warning).toMatch(/nonexistent/);
  });

  it("network failure: returns path:null + warning, does not throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));

    const result = await mediamtxPathStatus("cam1");

    expect(result.path).toBeNull();
    expect(result.warning).toMatch(/failed/i);
    expect(result.warning).toMatch(/timeout/);
  });
});
