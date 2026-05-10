import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/db", () => ({
  getRotationAge: vi.fn().mockReturnValue(null),
  // other exports the route does NOT use, included to prevent import errors
  readLastAuditLog: vi.fn().mockReturnValue(null),
  appendAuditLog: vi.fn(),
  saveProfile: vi.fn(),
  loadProfile: vi.fn(),
  listProfiles: vi.fn(() => []),
  markRotated: vi.fn(),
  listSgEntries: vi.fn(() => []),
  upsertSgEntry: vi.fn(),
  deleteSgEntry: vi.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { auth } from "@/lib/auth";
import { getRotationAge } from "@/lib/db";
import { GET } from "@/app/api/settings/rotations/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

// The route maps these 7 keys:
const ROTATABLE_KEYS = [
  "camera-sim-ssh",
  "aws-creds",
  "ngc-key",
  "nvidia-api-key",
  "hf-token",
  "slack-webhook",
  "console-password",
];

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(getRotationAge).mockReset().mockReturnValue(null);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/settings/rotations", () => {
  it("happy path: returns one entry per rotatable key with correct shape", async () => {
    // Two keys have been rotated recently (ageMs = 5 days), the rest are null.
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    vi.mocked(getRotationAge).mockImplementation((key) => {
      if (key === "ngc-key" || key === "console-password") return fiveDaysMs;
      return null;
    });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rotations).toHaveLength(ROTATABLE_KEYS.length);

    // ngc-key: age 5 days → ageDays:5, nagBanner:false (threshold is 90), lastRotatedAt non-null
    const ngc = body.rotations.find((r: { key: string }) => r.key === "ngc-key");
    expect(ngc).toBeDefined();
    expect(ngc.ageDays).toBe(5);
    expect(ngc.nagBanner).toBe(false);
    expect(ngc.lastRotatedAt).not.toBeNull();
    expect(ngc.label).toBe("NGC API key");

    // camera-sim-ssh: age null → ageDays:null, nagBanner:false, lastRotatedAt:null
    const camSsh = body.rotations.find((r: { key: string }) => r.key === "camera-sim-ssh");
    expect(camSsh.ageDays).toBeNull();
    expect(camSsh.nagBanner).toBe(false);
    expect(camSsh.lastRotatedAt).toBeNull();
  });

  it("nag banner fires when age >= 90 days", async () => {
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    vi.mocked(getRotationAge).mockReturnValue(ninetyDaysMs);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    // All keys have 90-day age → all should nag
    for (const entry of body.rotations) {
      expect(entry.ageDays).toBe(90);
      expect(entry.nagBanner).toBe(true);
      expect(entry.lastRotatedAt).not.toBeNull();
    }
  });

  it("no rotations recorded yet → all entries have ageDays:null, nagBanner:false", async () => {
    vi.mocked(getRotationAge).mockReturnValue(null);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rotations).toHaveLength(ROTATABLE_KEYS.length);
    for (const entry of body.rotations) {
      expect(entry.ageDays).toBeNull();
      expect(entry.nagBanner).toBe(false);
      expect(entry.lastRotatedAt).toBeNull();
    }
  });

  it("auth missing: returns 401 without calling getRotationAge", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(getRotationAge).not.toHaveBeenCalled();
  });
});
