import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/db", () => ({
  readLastAuditLog: vi.fn().mockReturnValue(null),
  // other exports — included to prevent import errors if db.ts is loaded transitively
  appendAuditLog: vi.fn(),
  saveProfile: vi.fn(),
  loadProfile: vi.fn(),
  listProfiles: vi.fn(() => []),
  markRotated: vi.fn(),
  getRotationAge: vi.fn().mockReturnValue(null),
  listSgEntries: vi.fn(() => []),
  upsertSgEntry: vi.fn(),
  deleteSgEntry: vi.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { auth } from "@/lib/auth";
import { readLastAuditLog } from "@/lib/db";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/audit/last/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(search = ""): NextRequest {
  return new NextRequest(`http://localhost/api/audit/last${search}`);
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(readLastAuditLog).mockReset().mockReturnValue(null);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/audit/last", () => {
  it("happy path: ?action=foo returns the matching audit row", async () => {
    const fakeRow = {
      id: 42,
      action: "secret-rotate",
      target: "rtvi/secret/ngc-secret",
      actor: "operator",
      payload: '{"key":"ngc-key"}',
      createdAt: "2026-05-10T09:00:00.000Z",
    };
    vi.mocked(readLastAuditLog).mockReturnValue(fakeRow as never);

    const req = makeRequest("?action=secret-rotate");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(fakeRow);
    expect(readLastAuditLog).toHaveBeenCalledOnce();
    expect(readLastAuditLog).toHaveBeenCalledWith("secret-rotate");
  });

  it("missing action param → 400 with descriptive error", async () => {
    const req = makeRequest(); // no query param

    const res = await GET(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/action/i);
    expect(readLastAuditLog).not.toHaveBeenCalled();
  });

  it("readLastAuditLog returns null (no matching row) → 200 with null body", async () => {
    vi.mocked(readLastAuditLog).mockReturnValue(null);

    const req = makeRequest("?action=never-happened");
    const res = await GET(req);

    // The route returns NextResponse.json(row) directly — when row is null the body is JSON null.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });

  it("auth missing: returns 401 without calling readLastAuditLog", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("?action=secret-rotate");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(readLastAuditLog).not.toHaveBeenCalled();
  });
});
