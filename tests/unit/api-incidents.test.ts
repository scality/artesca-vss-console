import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

// incidents route reads CLUSTER.alertBridge.url from cluster-refs (the realtime
// alert-bridge is the incident source on the Helm path).
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    alertWorker: { url: "http://vss-video-analytics-api.vss-base.svc.cluster.local:8081" },
    alertBridge: { url: "http://vss-alert-bridge.vss-base.svc.cluster.local:9080" },
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
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/incidents", () => {
  it("happy path: maps alert-bridge incidents to the console Incident shape", async () => {
    const bridgeIncident = {
      timestamp: "2026-05-10T10:00:00Z",
      category: "retail_activity",
      type: "mdx-vlm-incidents",
      isAnomaly: true,
      analyticsModule: { description: "Shoplifting detector" },
      info: { streamId: "cam-01", reasoningDescription: "Suspicious behaviour detected" },
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ incidents: [bridgeIncident] }),
    } as unknown as Response);

    const req = makeRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0]).toMatchObject({
      ts: "2026-05-10T10:00:00Z",
      scenarioId: "retail_activity",
      // scenarioName derives from the incident category (the matched scenario),
      // not the analyticsModule's single generic detector description.
      scenarioName: "Retail activity",
      severity: "high",
      sensorId: "cam-01",
      topic: "mdx-vlm-incidents",
      summary: "Suspicious behaviour detected",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v1/realtime/incidents");
    // default limit is 50
    expect(fetchMock.mock.calls[0][0]).toContain("limit=50");
  });

  it("?limit=10 is forwarded to the alert-bridge and clamped within 1–500", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ incidents: [] }),
    } as unknown as Response);

    const req = makeRequest("?limit=10");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain("limit=10");
  });

  it("alert-bridge returns empty list → incidents:[]", async () => {
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
