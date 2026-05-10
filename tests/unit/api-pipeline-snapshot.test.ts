import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/pipeline/aggregator", () => ({
  collectSnapshot: vi.fn().mockResolvedValue({ nodes: [], edges: [], health: "ok", warnings: [] }),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { auth } from "@/lib/auth";
import { collectSnapshot } from "@/lib/pipeline/aggregator";
import { GET } from "@/app/api/pipeline/snapshot/route";

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(collectSnapshot).mockReset().mockResolvedValue({
    nodes: [],
    edges: [],
    health: "ok",
    warnings: [],
  } as never);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/pipeline/snapshot", () => {
  it("happy path: returns collectSnapshot() result as JSON with 200", async () => {
    const fakeSnapshot = {
      nodes: [{ id: "vst", status: "running" }],
      edges: [{ from: "camera", to: "vst" }],
      health: "ok",
      warnings: [],
    };
    vi.mocked(collectSnapshot).mockResolvedValue(fakeSnapshot as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(fakeSnapshot);
    expect(collectSnapshot).toHaveBeenCalledOnce();
  });

  it("collectSnapshot resolves with degraded shape → still 200 (errors surface in payload)", async () => {
    const degradedSnapshot = {
      nodes: [],
      edges: [],
      health: "degraded",
      warnings: ["prometheus unreachable", "kafka probe failed"],
    };
    vi.mocked(collectSnapshot).mockResolvedValue(degradedSnapshot as never);

    const res = await GET();

    // The route passes through whatever collectSnapshot returns — degraded is a valid payload,
    // not an HTTP error (the aggregator is designed to resolve with warnings instead of throwing).
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.health).toBe("degraded");
    expect(body.warnings).toHaveLength(2);
  });

  it("auth missing: returns 401 without calling collectSnapshot", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(collectSnapshot).not.toHaveBeenCalled();
  });
});
