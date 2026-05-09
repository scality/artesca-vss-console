import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/db", () => ({
  saveProfile: vi.fn(),
  loadProfile: vi.fn(),
  listProfiles: vi.fn(() => []),
  appendAuditLog: vi.fn(),
  markRotated: vi.fn(),
  getRotationAge: vi.fn(() => null),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { listProfiles, saveProfile } from "@/lib/db";
import { auditLog } from "@/lib/helpers/audit";

import { GET, POST } from "@/app/api/profiles/route";

// ── Fixtures ───────────────────────────────────────────────────────────────────

// Minimal valid DemoProfileSchema body (omitting savedAt + savedBy which the route adds).
const VALID_PROFILE_BODY = {
  name: "test-profile",
  scenarios: [
    {
      id: "s1",
      name: "Checkout anomaly",
      severity: "high" as const,
      channels: ["ui"] as ["ui"],
      sensorFilter: "*",
      keywords: ["unusual"],
      enabled: true,
    },
  ],
  vlmPrompt: "Describe what you see.",
  cameras: [
    {
      id: "cam-01",
      role: "checkout" as const,
      feeds: [
        {
          id: "feed-01",
          sensorId: "sensor-01",
          source: "rtsp",
          rtspUrl: "rtsp://camera01/live",
          vstRegistered: false,
          replayReady: false,
        },
      ],
    },
  ],
  rtviTuning: {},
  alertTuning: {},
  nimModel: "cosmos-reason2-8b",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeGetRequest(): Request {
  return new Request("http://localhost/api/profiles");
}

function makePostRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/profiles", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(listProfiles).mockReset().mockReturnValue([]);
  vi.mocked(saveProfile).mockReset();
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);
});

// ── GET ────────────────────────────────────────────────────────────────────────

describe("GET /api/profiles", () => {
  it("returns profiles from listProfiles()", async () => {
    const mockProfiles = [
      {
        name: "scene-a",
        savedAt: "2026-01-01T00:00:00.000Z",
        savedBy: "operator",
        scenarios: [],
        vlmPrompt: "prompt",
        cameras: [],
        rtviTuning: {},
        alertTuning: {},
        nimModel: "cosmos-reason2-8b",
      },
    ];
    vi.mocked(listProfiles).mockReturnValue(mockProfiles as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profiles).toEqual(mockProfiles);
    expect(listProfiles).toHaveBeenCalledOnce();
  });

  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(listProfiles).not.toHaveBeenCalled();
  });
});

// ── POST ───────────────────────────────────────────────────────────────────────

describe("POST /api/profiles", () => {
  it("happy path: saveProfile called with body + operator name, audit logged, returns 200", async () => {
    const req = makePostRequest(VALID_PROFILE_BODY);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe("test-profile");
    expect(body.savedAt).toBeDefined();

    expect(saveProfile).toHaveBeenCalledOnce();
    const [savedProfile, operator] = vi.mocked(saveProfile).mock.calls[0];
    expect(savedProfile.name).toBe("test-profile");
    expect(operator).toBe("operator");

    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith(
      "profile-save",
      "profile/test-profile",
      { name: "test-profile" }
    );
  });

  it("invalid body: 400 from zod (DemoProfileSchema)", async () => {
    const req = makePostRequest({ name: "" }); // name must be min(1), missing required fields
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/validation failed/i);
    expect(saveProfile).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("kiosk mode: rejectIfKiosk returns 403 → short-circuits, saveProfile not called", async () => {
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

    const req = makePostRequest(VALID_PROFILE_BODY);
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(saveProfile).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makePostRequest(VALID_PROFILE_BODY);
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(saveProfile).not.toHaveBeenCalled();
  });
});
