import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/overview-collector", () => ({
  collectPodSummaries: vi.fn().mockResolvedValue({ pods: [], warnings: [] }),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { auth } from "@/lib/auth";
import { collectPodSummaries } from "@/lib/overview-collector";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/pods/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeGetRequest(search = ""): NextRequest {
  // NextRequest wraps the URL into nextUrl so searchParams resolution works.
  return new NextRequest(`http://localhost/api/pods${search}`);
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(collectPodSummaries).mockReset().mockResolvedValue({ pods: [], warnings: [] });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/pods", () => {
  it("happy path: returns collectPodSummaries() result as JSON with 200", async () => {
    const fakePods = [{ name: "sensor-ms-abc", namespace: "vst", phase: "Running" }];
    vi.mocked(collectPodSummaries).mockResolvedValue({
      pods: fakePods as never,
      warnings: [],
    });

    const req = makeGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pods).toEqual(fakePods);
    expect(body.warnings).toEqual([]);
    expect(collectPodSummaries).toHaveBeenCalledOnce();
    expect(collectPodSummaries).toHaveBeenCalledWith(undefined);
  });

  it("with ?ns=vst: forwards the namespace param to collectPodSummaries", async () => {
    const req = makeGetRequest("?ns=vst");
    await GET(req);

    expect(collectPodSummaries).toHaveBeenCalledOnce();
    expect(collectPodSummaries).toHaveBeenCalledWith("vst");
  });

  it("auth missing: returns 401 without calling collectPodSummaries", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeGetRequest();
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(collectPodSummaries).not.toHaveBeenCalled();
  });
});
