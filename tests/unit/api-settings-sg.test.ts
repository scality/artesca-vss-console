import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — must be declared before any imports that trigger the modules ──

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/ec2-sg", () => ({
  authorizeSgIngress: vi.fn().mockResolvedValue(undefined),
  revokeSgIngress: vi.fn().mockResolvedValue(undefined),
  listSgIngress: vi.fn().mockResolvedValue([]),
  sgManagementConfig: vi.fn(),
  CONSOLE_INGRESS_PORT: 8800,
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
import { authorizeSgIngress, revokeSgIngress, sgManagementConfig } from "@/lib/ec2-sg";
import { listSgEntries, upsertSgEntry, deleteSgEntry } from "@/lib/db";
import { auditLog } from "@/lib/helpers/audit";

// Import route handlers after mocks are set up.
import { GET, POST } from "@/app/api/settings/sg/route";
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
  vi.mocked(sgManagementConfig).mockReturnValue({ sgId: SG_ID, region: "us-west-2" });
});

// ── POST ─────────────────────────────────────────────────────────────────────────

// ── GET — the capability probe ───────────────────────────────────────────────────
//
// /settings decides whether to render the SG panel at all from this response, so
// the flag is load-bearing: get it wrong and a customer cluster shows a panel
// whose every button 404s.

describe("GET /api/settings/sg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { name: "operator" } } as never);
  });

  it("reports available with the stored rows when a group is managed", async () => {
    vi.mocked(sgManagementConfig).mockReturnValue({ sgId: SG_ID, region: "us-west-2" });
    vi.mocked(listSgEntries).mockReturnValue([
      {
        id: "e1",
        cidr: VALID_CIDR,
        label: VALID_LABEL,
        addedBy: "operator",
        addedAt: "2026-08-01T00:00:00.000Z",
        port: 8800,
      },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: true, entries: [{ id: "e1" }] });
  });

  // A 200 with a flag, not a 404: this is the probe, and an error status would
  // leave the page unable to tell "not part of this deployment" from "broken".
  it("reports unavailable as a 200 when no group is managed", async () => {
    vi.mocked(sgManagementConfig).mockReturnValue(null);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, entries: [] });
  });

  // The rows describe ingress rules on an AWS security group. Where none is
  // managed they mirror nothing, so serving them would furnish a page with
  // network rules that do not exist for this cluster.
  it("withholds the stored rows when no group is managed", async () => {
    vi.mocked(sgManagementConfig).mockReturnValue(null);
    vi.mocked(listSgEntries).mockReturnValue([
      {
        id: "stale",
        cidr: "192.0.2.0/24",
        label: "from another cluster",
        addedBy: "operator",
        addedAt: "2026-01-01T00:00:00.000Z",
        port: 8800,
      },
    ]);

    const body = await (await GET()).json();

    expect(body.entries).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("192.0.2.0/24");
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await GET()).status).toBe(401);
  });
});

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
    expect(authorizeSgIngress).toHaveBeenCalledWith(
      { sgId: SG_ID, region: "us-west-2" },
      VALID_CIDR,
      8800
    );
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

  // A deployment that manages no security group has no such route, so this is a
  // 404 rather than the 500 a misconfiguration would deserve. It is resolved
  // before the body is parsed, so an unconfigured deployment answers the same
  // way whatever was posted.
  it("no security group under management → 404, and nothing is written", async () => {
    vi.mocked(sgManagementConfig).mockReturnValue(null);

    const req = makePostRequest({ cidr: VALID_CIDR, label: VALID_LABEL });
    const res = await POST(req);

    expect(res.status).toBe(404);
    expect(authorizeSgIngress).not.toHaveBeenCalled();
    expect(upsertSgEntry).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("no security group under management → 404 even for an invalid body", async () => {
    vi.mocked(sgManagementConfig).mockReturnValue(null);

    const res = await POST(makePostRequest({ cidr: "not-a-cidr", label: "" }));

    expect(res.status).toBe(404);
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
    expect(revokeSgIngress).toHaveBeenCalledWith(
      { sgId: SG_ID, region: "us-west-2" },
      ENTRY.cidr,
      ENTRY.port
    );
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

  it("no security group under management → 404, and nothing is revoked", async () => {
    vi.mocked(sgManagementConfig).mockReturnValue(null);

    const req = new Request(`http://localhost/api/settings/sg/${ENTRY_ID}`, { method: "DELETE" });
    const res = await DELETE(req, makeDeleteParams(ENTRY_ID));

    expect(res.status).toBe(404);
    expect(revokeSgIngress).not.toHaveBeenCalled();
    expect(deleteSgEntry).not.toHaveBeenCalled();
  });
});
