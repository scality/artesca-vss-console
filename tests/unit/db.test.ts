import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { DemoProfile, SgWhitelistEntry } from "@/lib/types";
import type {
  CameraOverrideRow,
  AuditLogRow,
} from "@/lib/db";

// db.ts registers process.once("SIGTERM"/"SIGINT") on every fresh module instance.
// With ~19 tests each resetting modules, 19 × 2 listeners accumulate. Raise the
// limit so Node doesn't emit the MaxListenersExceeded warning.
process.setMaxListeners(Math.max(process.getMaxListeners(), 50));

// ─── Module isolation helpers ────────────────────────────────────────────────
//
// db.ts holds module-level singletons (_db, _signalHandlersRegistered).
// To get a fresh getDb() per test we must vi.resetModules() + re-import.
// After resetModules the global vi.mock("server-only") from setup.ts no longer
// applies to newly resolved modules, so we re-mock it with vi.doMock() first.

let tmpDir: string;

// Typed shorthands — filled by beforeEach dynamic import
let getDb: () => import("better-sqlite3").Database;
let appendAuditLog: (e: { operator: string; action: string; target: string; detailsJson: string }) => Promise<void>;
let readLastAuditLog: (action: string) => AuditLogRow | null;
let saveProfile: (p: DemoProfile, savedBy: string) => void;
let listProfiles: () => Array<{ name: string; savedAt: string; savedBy: string }>;
let loadProfile: (name: string) => DemoProfile | null;
let upsertSgEntry: (e: SgWhitelistEntry) => void;
let listSgEntries: () => SgWhitelistEntry[];
let deleteSgEntry: (id: string) => void;
let upsertCameraOverride: (r: CameraOverrideRow) => void;
let getCameraOverride: (cameraId: string) => CameraOverrideRow | null;
let listCameraOverrides: () => CameraOverrideRow[];
let deleteCameraOverride: (cameraId: string) => void;
let markRotated: (key: string) => void;
let getRotationAge: (key: string) => number | null;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `console-test-${randomUUID()}`);
  vi.stubEnv("CONSOLE_DATA_DIR", tmpDir);
  vi.resetModules();
  // Re-stub server-only after module reset so the freshly resolved db.ts
  // doesn't throw "This module cannot be imported from a Client Component".
  vi.doMock("server-only", () => ({}));

  const mod = await import("@/lib/db");
  getDb = mod.getDb;
  appendAuditLog = mod.appendAuditLog;
  readLastAuditLog = mod.readLastAuditLog;
  saveProfile = mod.saveProfile;
  listProfiles = mod.listProfiles;
  loadProfile = mod.loadProfile;
  upsertSgEntry = mod.upsertSgEntry;
  listSgEntries = mod.listSgEntries;
  deleteSgEntry = mod.deleteSgEntry;
  upsertCameraOverride = mod.upsertCameraOverride;
  getCameraOverride = mod.getCameraOverride;
  listCameraOverrides = mod.listCameraOverrides;
  deleteCameraOverride = mod.deleteCameraOverride;
  markRotated = mod.markRotated;
  getRotationAge = mod.getRotationAge;
});

afterEach(() => {
  // Close the connection held by the module singleton before removing the file.
  try {
    getDb().close();
  } catch {
    // already closed or never opened — ignore
  }
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Minimal valid DemoProfile fixture ───────────────────────────────────────

function makeProfile(name = "test-profile"): DemoProfile {
  return {
    name,
    savedAt: new Date().toISOString(),
    savedBy: "test-operator",
    scenarios: [],
    vlmPrompt: "Describe what you see.",
    cameras: [],
    rtviTuning: {},
    alertTuning: {},
    nimModel: "cosmos-reason2-8b",
  };
}

// ─── Migrations + pragmas ─────────────────────────────────────────────────────

describe("migrations + pragmas", () => {
  it("creates the database file on first getDb() call", () => {
    getDb();
    const dbFile = path.join(tmpDir, "console-data.db");
    expect(fs.existsSync(dbFile)).toBe(true);
  });

  it("all 5 tables exist after first call", () => {
    const db = getDb();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain("profiles");
    expect(tables).toContain("audit_log");
    expect(tables).toContain("sg_whitelist");
    expect(tables).toContain("rotations");
    expect(tables).toContain("camera_overrides");
  });

  it("journal_mode=WAL is applied", () => {
    const db = getDb();
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
  });

  it("synchronous=NORMAL is applied", () => {
    const db = getDb();
    // SQLite returns 1 for NORMAL
    const sync = db.pragma("synchronous", { simple: true });
    expect(sync).toBe(1);
  });

  it("foreign_keys=ON is applied", () => {
    const db = getDb();
    const fk = db.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
  });

  it("getDb() is a singleton — two calls return the same instance", () => {
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
  });
});

// ─── Audit log ────────────────────────────────────────────────────────────────

describe("audit log", () => {
  it("appendAuditLog + readLastAuditLog round-trips and computes non-negative agoSecs", async () => {
    await appendAuditLog({
      operator: "alice",
      action: "sg.add",
      target: "10.0.0.0/8",
      detailsJson: JSON.stringify({ note: "test" }),
    });

    const row = readLastAuditLog("sg.add");
    expect(row).not.toBeNull();
    expect(row!.action).toBe("sg.add");
    expect(row!.target).toBe("10.0.0.0/8");
    expect(row!.operator).toBe("alice");
    expect(row!.agoSecs).toBeGreaterThanOrEqual(0);
  });

  it("readLastAuditLog returns null when no rows match the action", () => {
    const row = readLastAuditLog("nonexistent.action");
    expect(row).toBeNull();
  });
});

// ─── Profiles ─────────────────────────────────────────────────────────────────

describe("profiles", () => {
  it("saveProfile + loadProfile round-trips a valid DemoProfile", () => {
    const p = makeProfile("my-scene");
    saveProfile(p, "alice");
    const loaded = loadProfile("my-scene");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("my-scene");
    expect(loaded!.nimModel).toBe("cosmos-reason2-8b");
    expect(loaded!.vlmPrompt).toBe("Describe what you see.");
  });

  it("listProfiles returns entries in saved-at DESC order", () => {
    // saveProfile() always stamps saved_at = new Date().toISOString() internally,
    // so two back-to-back calls can land on the same millisecond.
    // Insert via getDb() directly to control saved_at values precisely.
    const db = getDb();
    const older = "2026-04-01T00:00:00.000Z";
    const newer = "2026-04-22T00:00:00.000Z";
    db.prepare(
      "INSERT OR REPLACE INTO profiles (name, saved_at, saved_by, payload_json) VALUES (?, ?, ?, ?)"
    ).run("first", older, "alice", JSON.stringify(makeProfile("first")));
    db.prepare(
      "INSERT OR REPLACE INTO profiles (name, saved_at, saved_by, payload_json) VALUES (?, ?, ?, ?)"
    ).run("second", newer, "alice", JSON.stringify(makeProfile("second")));

    const list = listProfiles();
    expect(list.length).toBe(2);
    // DESC order: "second" (newer timestamp) should come first
    expect(list[0].name).toBe("second");
    expect(list[1].name).toBe("first");
  });

  it("loadProfile returns null for a nonexistent name", () => {
    const result = loadProfile("does-not-exist");
    expect(result).toBeNull();
  });
});

// ─── SG whitelist ─────────────────────────────────────────────────────────────

describe("sg whitelist", () => {
  const base: SgWhitelistEntry = {
    id: randomUUID(),
    cidr: "84.14.13.200/29",
    label: "Scality Paris office",
    addedBy: "alice",
    addedAt: new Date().toISOString(),
    port: 8800,
  };

  it("upsertSgEntry + listSgEntries returns the inserted entry", () => {
    upsertSgEntry(base);
    const entries = listSgEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].cidr).toBe("84.14.13.200/29");
    expect(entries[0].id).toBe(base.id);
  });

  it("upsertSgEntry with same id replaces the row (updated cidr visible)", () => {
    upsertSgEntry(base);
    const updated: SgWhitelistEntry = { ...base, cidr: "192.168.1.0/24" };
    upsertSgEntry(updated);
    const entries = listSgEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].cidr).toBe("192.168.1.0/24");
  });

  it("deleteSgEntry removes the row", () => {
    upsertSgEntry(base);
    deleteSgEntry(base.id);
    const entries = listSgEntries();
    expect(entries).toHaveLength(0);
  });
});

// ─── Camera overrides ─────────────────────────────────────────────────────────

describe("camera overrides", () => {
  function makeOverride(cameraId: string, scenarioIds: string[] | null = ["s1", "s2"]): CameraOverrideRow {
    return {
      cameraId,
      scenarioIds,
      recordingEnabled: true,
      recordingPolicy: "event-only",
      recordingRetentionDays: 7,
      updatedAt: new Date().toISOString(),
      updatedBy: "alice",
    };
  }

  it("upsertCameraOverride + getCameraOverride round-trips including JSON-encoded scenarioIds", () => {
    upsertCameraOverride(makeOverride("cam-1", ["s1", "s2"]));
    const row = getCameraOverride("cam-1");
    expect(row).not.toBeNull();
    expect(row!.cameraId).toBe("cam-1");
    expect(row!.scenarioIds).toEqual(["s1", "s2"]);
    expect(row!.recordingEnabled).toBe(true);
    expect(row!.recordingPolicy).toBe("event-only");
    expect(row!.recordingRetentionDays).toBe(7);
  });

  it("scenarioIds: null and scenarioIds: [] are stored and retrieved distinctly", () => {
    upsertCameraOverride(makeOverride("cam-null", null));
    upsertCameraOverride(makeOverride("cam-empty", []));

    const nullRow = getCameraOverride("cam-null");
    const emptyRow = getCameraOverride("cam-empty");

    expect(nullRow!.scenarioIds).toBeNull();
    expect(emptyRow!.scenarioIds).toEqual([]);
  });

  it("listCameraOverrides returns all rows; deleteCameraOverride removes one", () => {
    upsertCameraOverride(makeOverride("cam-a"));
    upsertCameraOverride(makeOverride("cam-b"));
    expect(listCameraOverrides()).toHaveLength(2);

    deleteCameraOverride("cam-a");
    const remaining = listCameraOverrides();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].cameraId).toBe("cam-b");
  });
});

// ─── Rotation tracking ────────────────────────────────────────────────────────

describe("rotation tracking", () => {
  it("markRotated + getRotationAge returns a non-negative number of milliseconds", () => {
    markRotated("ngc-api-key");
    const age = getRotationAge("ngc-api-key");
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(5000); // test runs in under 5 s
  });

  it("getRotationAge returns null for an unknown key", () => {
    const age = getRotationAge("never-rotated-key");
    expect(age).toBeNull();
  });
});
