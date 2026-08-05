import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Constants ─────────────────────────────────────────────────────────────────

// Must be a plain string — referenced both in the factory (hoisted, no closure)
// and in the URL-encoding assertion test below.
const PROM_URL = "http://prometheus.test:9090";

// ── Module mocks ──────────────────────────────────────────────────────────────

// cluster-refs reads process.env at module evaluation time; mock the whole
// module so PROMETHEUS_URL resolves to a stable test value.
// NOTE: vi.mock factories are hoisted — no top-level variables allowed inside;
// the URL literal must appear directly in the factory body.
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    prometheus: { url: "http://prometheus.test:9090" },
    // Stub every other field that cluster-refs consumers might destructure
    kafka: { brokers: [] },
    redis: { url: "" },
    vst: {},
    mediamtx: {},
    alertWorker: { url: "" },
    rtvi: {},
    nim: { previewEndpoint: "" },
    scenarios: {},
    alertsTuning: {},
    cameras: {},
    s3: {},
    restartableComponents: {},
  },
}));

import { promQuery } from "@/lib/helpers/prometheus";

// ── Setup ─────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePromResponse(results: unknown[], status: "success" | "error" = "success") {
  return {
    status,
    data: { resultType: "vector", result: results },
  };
}

function makeOkFetchResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

// ── promQuery ─────────────────────────────────────────────────────────────────

describe("promQuery", () => {
  it("happy path: returns parsed results and no warning", async () => {
    const fakeResults = [
      { metric: { __name__: "up", job: "vst" }, value: [1715000000, "1"] },
    ];
    mockFetch.mockResolvedValueOnce(makeOkFetchResponse(makePromResponse(fakeResults)));

    const { results, warning } = await promQuery('up{job="vst"}');

    expect(results).toEqual(fakeResults);
    expect(warning).toBeUndefined();
  });

  it("encodes the query string in the URL passed to fetch", async () => {
    mockFetch.mockResolvedValueOnce(makeOkFetchResponse(makePromResponse([])));

    const query = 'container_memory_usage_bytes{namespace="rtvi"}';
    await promQuery(query);

    const [calledUrl] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe(
      `${PROM_URL}/api/v1/query?query=${encodeURIComponent(query)}`,
    );
  });

  it("network error → returns empty results and warning, does not throw", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { results, warning } = await promQuery("up");

    expect(results).toEqual([]);
    expect(warning).toMatch(/unreachable.*ECONNREFUSED/i);
  });

  it("HTTP 5xx response → returns empty results and warning with status code", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

    const { results, warning } = await promQuery("up");

    expect(results).toEqual([]);
    expect(warning).toMatch(/503/);
  });

  it("Prometheus status !== success → returns empty results and warning", async () => {
    mockFetch.mockResolvedValueOnce(
      makeOkFetchResponse({ status: "error", error: "parse error", data: { resultType: "vector", result: [] } }),
    );

    const { results, warning } = await promQuery("bad[query");

    expect(results).toEqual([]);
    expect(warning).toMatch(/parse error/i);
  });

  it("non-JSON response (json() throws) → returns empty results and warning", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    });

    const { results, warning } = await promQuery("up");

    expect(results).toEqual([]);
    expect(warning).toMatch(/unreachable|unexpected token/i);
  });
});
