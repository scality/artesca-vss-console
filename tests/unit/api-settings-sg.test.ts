import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — must be declared before any imports that trigger the modules ──

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/aws", () => ({
  authorizeSgIngress: vi.fn().mockResolvedValue(undefined),
  revokeSgIngress: vi.fn().mockResolvedValue(undefined),
  listSgIngress: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/db", () => ({
  listSgEntries: vi.fn().mockReturnValue([]),
  upsertSgEntry: vi.fn(),
  deleteSgEntry: vi.fn(),
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// auditLog is the helper used by the routes — mock it to avoid a real auth lookup.
vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { authorizeSgIngress, revokeSgIngress } from "@/lib/aws";
import { listSgEntries, upsertSgEntry, deleteSgEntry } from "@/lib/db";
import { auditLog } from "@/lib/helpers/audit";

// Import route handlers after mocks are set up.
import { POST } from "@/app/api/settings/sg/route";
import { DELETE } from "@/app/api/settings/sg/[id]/route";

// ── Helpers ─────────────────────────────────────────────────────────────────────

const VALID_CIDR = "10.0.0.0/24";
const VALID_LABEL = "office";
const SG_ID = "sg-0123456789abcdef0";

function makePostRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/settings/sg", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

function makeDeleteParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ── Setup ────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Clear call history and reset implementations before each test.
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(authorizeSgIngress).mockReset().mockResolvedValue(undefined);
  vi.mocked(revokeSgIngress).mockReset().mockResolvedValue(undefined);
  vi.mocked(listSgEntries).mockReset().mockReturnValue([]);
  vi.mocked(upsertSgEntry).mockReset().mockReturnValue(undefined);
  vi.mocked(deleteSgEntry).mockReset().mockReturnValue(undefined);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);
  process.env.CONSOLE_SG_ID = SG_ID;
});

// ── POST ─────────────────────────────────────────────────────────────────────────

describe("POST /api/settings/sg", () => {
  it("happy path: valid CIDR + label → 200 with ok:true, calls authorizeSgIngress and auditLog", async () => {
    const req = makePostRequest({ cidr: VALID_CIDR, label: VALID_LABEL });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.entry.cidr).toBe(VALID_CIDR);
    expect(body.entry.label).toBe(VALID_LABEL);

    expect(authorizeSgIngress).toHaveBeenCalledOnce();
    expect(authorizeSgIngress).toHaveBeenCalledWith(SG_ID, VALID_CIDR, 8800);
    expect(upsertSgEntry).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith("sg-add", `sg/${SG_ID}/ingress`, {
      cidr: VALID_CIDR,
      label: VALID_LABEL,
      port: 8800,
    });
  });

  it("kiosk mode: rejectIfKiosk returns 403 → handler short-circuits, no AWS call", async () => {
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

    const req = makePostRequest({ cidr: VALID_CIDR, label: VALID_LABEL });
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(authorizeSgIngress).not.toHaveBeenCalled();
    expect(upsertSgEntry).not.toHaveBeenCalled();
  });

  it("missing auth: auth() returns null → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makePostRequest({ cidr: VALID_CIDR, label: VALID_LABEL });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(authorizeSgIngress).not.toHaveBeenCalled();
  });

  it("invalid CIDR '999.999.999.999/32' → 400, no AWS call", async () => {
    const req = makePostRequest({ cidr: "999.999.999.999/32", label: VALID_LABEL });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(authorizeSgIngress).not.toHaveBeenCalled();
  });

  it("invalid CIDR (not an IP at all) → 400", async () => {
    const req = makePostRequest({ cidr: "not-an-ip", label: VALID_LABEL });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(authorizeSgIngress).not.toHaveBeenCalled();
  });

  it("missing label → 400", async () => {
    const req = makePostRequest({ cidr: VALID_CIDR });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(authorizeSgIngress).not.toHaveBeenCalled();
  });

  it("empty body → 400", async () => {
    const req = makePostRequest({});
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(authorizeSgIngress).not.toHaveBeenCalled();
  });

  it("AWS authorizeSgIngress throws a non-duplicate error → 502 with generic message, logs error", async () => {
    const awsError = Object.assign(new Error("aws failure"), { name: "SomeOtherError" });
    vi.mocked(authorizeSgIngress).mockRejectedValue(awsError);

    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderrWrites.push(String(args[0])); });
    vi.stubEnv("LOG_PRETTY", "0");

    const req = makePostRequest({ cidr: VALID_CIDR, label: VALID_LABEL });
    const res = await POST(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/aws rejected/i);
    expect(stderrWrites.map((s) => JSON.parse(s))).toContainEqual(
      expect.objectContaining({ level: "error", scope: "api/settings/sg", msg: expect.stringContaining("sg-write aws error") }),
    );

    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("AWS throws InvalidPermission.Duplicate → treated as success (already authorized), proceeds to persist", async () => {
    const dupError = Object.assign(new Error("already exists"), { name: "InvalidPermission.Duplicate" });
    vi.mocked(authorizeSgIngress).mockRejectedValue(dupError);

    const req = makePostRequest({ cidr: VALID_CIDR, label: VALID_LABEL });
    const res = await POST(req);

    // Duplicate is silently ignored — proceeds to upsert + auditLog
    expect(res.status).toBe(200);
    expect(upsertSgEntry).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalled();
  });

  it("CONSOLE_SG_ID env var missing → 500", async () => {
    delete process.env.CONSOLE_SG_ID;

    const req = makePostRequest({ cidr: VALID_CIDR, label: VALID_LABEL });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/CONSOLE_SG_ID/);
  });
});

// ── DELETE ───────────────────────────────────────────────────────────────────────

describe("DELETE /api/settings/sg/[id]", () => {
  const ENTRY_ID = "550e8400-e29b-41d4-a716-446655440001";
  const ENTRY = {
    id: ENTRY_ID,
    cidr: "203.0.113.0/29",
    label: "Scality Paris",
    addedBy: "operator",
    addedAt: "2026-04-01T09:00:00.000Z",
    port: 8800 as const,
  };

  beforeEach(() => {
    vi.mocked(listSgEntries).mockReturnValue([ENTRY]);
  });

  it("happy path: valid id → 200 with ok:true, calls revokeSgIngress and auditLog", async () => {
    const req = new Request(`http://localhost/api/settings/sg/${ENTRY_ID}`, { method: "DELETE" });
    const res = await DELETE(req, makeDeleteParams(ENTRY_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe(ENTRY_ID);

    expect(revokeSgIngress).toHaveBeenCalledOnce();
    expect(revokeSgIngress).toHaveBeenCalledWith(SG_ID, ENTRY.cidr, ENTRY.port);
    expect(deleteSgEntry).toHaveBeenCalledWith(ENTRY_ID);
    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith("sg-remove", `sg/${SG_ID}/ingress`, {
      cidr: ENTRY.cidr,
      label: ENTRY.label,
      port: ENTRY.port,
    });
  });

  it("kiosk mode: rejectIfKiosk returns 403 → short-circuits, no AWS call", async () => {
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

    const req = new Request(`http://localhost/api/settings/sg/${ENTRY_ID}`, { method: "DELETE" });
    const res = await DELETE(req, makeDeleteParams(ENTRY_ID));

    expect(res.status).toBe(403);
    expect(revokeSgIngress).not.toHaveBeenCalled();
    expect(deleteSgEntry).not.toHaveBeenCalled();
  });

  it("missing auth → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = new Request(`http://localhost/api/settings/sg/${ENTRY_ID}`, { method: "DELETE" });
    const res = await DELETE(req, makeDeleteParams(ENTRY_ID));

    expect(res.status).toBe(401);
    expect(revokeSgIngress).not.toHaveBeenCalled();
  });

  it("id not found in DB → 404", async () => {
    vi.mocked(listSgEntries).mockReturnValue([]);

    const req = new Request(`http://localhost/api/settings/sg/nonexistent`, { method: "DELETE" });
    const res = await DELETE(req, makeDeleteParams("nonexistent"));

    expect(res.status).toBe(404);
    expect(revokeSgIngress).not.toHaveBeenCalled();
  });

  it("AWS revokeSgIngress throws a non-not-found error → 502 with generic message, logs error", async () => {
    const awsError = Object.assign(new Error("aws failure"), { name: "SomeOtherError" });
    vi.mocked(revokeSgIngress).mockRejectedValue(awsError);

    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderrWrites.push(String(args[0])); });
    vi.stubEnv("LOG_PRETTY", "0");

    const req = new Request(`http://localhost/api/settings/sg/${ENTRY_ID}`, { method: "DELETE" });
    const res = await DELETE(req, makeDeleteParams(ENTRY_ID));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/aws rejected/i);
    expect(stderrWrites.map((s) => JSON.parse(s))).toContainEqual(
      expect.objectContaining({ level: "error", scope: "api/settings/sg/[id]", msg: expect.stringContaining("sg-write aws error") }),
    );

    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("AWS throws InvalidPermission.NotFound → treated as success (already gone), proceeds to delete from DB", async () => {
    const notFoundError = Object.assign(new Error("not found"), { name: "InvalidPermission.NotFound" });
    vi.mocked(revokeSgIngress).mockRejectedValue(notFoundError);

    const req = new Request(`http://localhost/api/settings/sg/${ENTRY_ID}`, { method: "DELETE" });
    const res = await DELETE(req, makeDeleteParams(ENTRY_ID));

    expect(res.status).toBe(200);
    expect(deleteSgEntry).toHaveBeenCalledWith(ENTRY_ID);
    expect(auditLog).toHaveBeenCalled();
  });

  it("CONSOLE_SG_ID env var missing → 500", async () => {
    delete process.env.CONSOLE_SG_ID;

    const req = new Request(`http://localhost/api/settings/sg/${ENTRY_ID}`, { method: "DELETE" });
    const res = await DELETE(req, makeDeleteParams(ENTRY_ID));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/CONSOLE_SG_ID/);
  });
});
