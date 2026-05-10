import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { name: "test-operator", email: "test@example.com" },
  }),
}));

import { appendAuditLog } from "@/lib/db";
import { auth } from "@/lib/auth";
import { auditLog, auditLogAs } from "@/lib/helpers/audit";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(appendAuditLog).mockReset().mockResolvedValue(undefined);
  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "test-operator", email: "test@example.com" },
  } as never);
});

// ── auditLog ──────────────────────────────────────────────────────────────────

describe("auditLog", () => {
  it("forwards action, target, and JSON-serialised details to appendAuditLog", async () => {
    await auditLog("camera-add", "camera/cam-01", { id: "cam-01" });

    expect(appendAuditLog).toHaveBeenCalledOnce();
    expect(appendAuditLog).toHaveBeenCalledWith({
      operator: "test-operator",
      action: "camera-add",
      target: "camera/cam-01",
      detailsJson: JSON.stringify({ id: "cam-01" }),
    });
  });

  it("resolves operator from session user.name when available", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { name: "alice", email: "alice@example.com" },
    } as never);

    await auditLog("prompt-update", "prompt", {});

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ operator: "alice" }),
    );
  });

  it("falls back to session user.email when user.name is absent", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { email: "bob@example.com" },
    } as never);

    await auditLog("scenario-delete", "scenario/foo", {});

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ operator: "bob@example.com" }),
    );
  });

  it("falls back to \"unknown\" when session is null", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    await auditLog("settings-change", "settings", {});

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ operator: "unknown" }),
    );
  });

  it("propagates rejection from appendAuditLog", async () => {
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("db write failed"));

    await expect(auditLog("action", "target", {})).rejects.toThrow("db write failed");
  });
});

// ── auditLogAs ────────────────────────────────────────────────────────────────

describe("auditLogAs", () => {
  it("uses the supplied operator string directly, no session lookup", async () => {
    await auditLogAs("system-job", "restart", "service/rtvi", { reason: "manual" });

    expect(auth).not.toHaveBeenCalled();
    expect(appendAuditLog).toHaveBeenCalledOnce();
    expect(appendAuditLog).toHaveBeenCalledWith({
      operator: "system-job",
      action: "restart",
      target: "service/rtvi",
      detailsJson: JSON.stringify({ reason: "manual" }),
    });
  });

  it("propagates rejection from appendAuditLog", async () => {
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("db unavailable"));

    await expect(auditLogAs("op", "act", "tgt", {})).rejects.toThrow("db unavailable");
  });
});
