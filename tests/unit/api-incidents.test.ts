import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

// incidents route reads CLUSTER.alertWorker.url from cluster-refs
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    alertWorker: { url: "http://vss-video-analytics-api.vss-base.svc.cluster.local:8081" },
  },
}));

// stub fs so docker-path tests don't touch disk
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { auth } from "@/lib/auth";
import { existsSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/incidents/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(search = ""): NextRequest {
  return new NextRequest(`http://localhost/api/incidents${search}`);
}

const fetchMock = vi.fn();

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(existsSync).mockReset().mockReturnValue(false);
  vi.mocked(readFileSync).mockReset().mockReturnValue("");
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ incidents: [] }),
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.CONSOLE_RUNTIME;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/incidents", () => {
  it("happy path: returns incident list from alert-worker", async () => {
    const fakeIncidents = [
      {
        ts: "2026-05-10T10:00:00Z",
        scenarioId: "shoplifting",
        scenarioName: "Shoplifting",
        severity: "high",
        sensorId: "cam-01",
        topic: "mdx-vlm",
        summary: "Suspicious behaviour detected",
      },
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ incidents: fakeIncidents }),
    } as unknown as Response);

    const req = makeRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.incidents).toEqual(fakeIncidents);
    expect(fetchMock).toHaveBeenCalledOnce();
    // default limit is 50
    expect(fetchMock.mock.calls[0][0]).toContain("limit=50");
  });

  it("?limit=10 is forwarded to alert-worker and clamped within 1–500", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ incidents: [] }),
    } as unknown as Response);

    const req = makeRequest("?limit=10");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain("limit=10");
  });

  it("alert-worker returns empty list → incidents:[]", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ incidents: [] }),
    } as unknown as Response);

    const req = makeRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.incidents).toEqual([]);
  });

  it("auth missing: returns 401 without calling fetch", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest();
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
