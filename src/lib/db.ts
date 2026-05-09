import "server-only";
import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
import {
  DemoProfileSchema,
  SgWhitelistEntrySchema,
} from "./schemas";
import type { DemoProfile, SgWhitelistEntry, AuditLogEntry } from "./types";

let _db: Database.Database | null = null;
let _signalHandlersRegistered = false;

function dbPath(): string {
  const dir = process.env.CONSOLE_DATA_DIR ?? "/data";
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "console-data.db");
}

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(dbPath());
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("busy_timeout = 5000");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      name       TEXT PRIMARY KEY,
      saved_at   TEXT NOT NULL,
      saved_by   TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY,
      ts          TEXT NOT NULL,
      operator    TEXT NOT NULL,
      action      TEXT NOT NULL,
      target      TEXT NOT NULL,
      details_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sg_whitelist (
      id        TEXT PRIMARY KEY,
      cidr      TEXT NOT NULL,
      label     TEXT NOT NULL,
      added_by  TEXT NOT NULL,
      added_at  TEXT NOT NULL,
      port      INTEGER NOT NULL DEFAULT 8800
    );

    CREATE TABLE IF NOT EXISTS rotations (
      key        TEXT PRIMARY KEY,
      rotated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS camera_overrides (
      camera_id                TEXT PRIMARY KEY,
      scenario_ids             TEXT,
      recording_enabled        INTEGER,
      recording_policy         TEXT,
      recording_retention_days INTEGER,
      updated_at               TEXT NOT NULL,
      updated_by               TEXT NOT NULL
    );
  `);

  if (!_signalHandlersRegistered) {
    _signalHandlersRegistered = true;
    const closeAndExit = () => {
      _db?.close();
      process.exit(0);
    };
    process.once("SIGTERM", closeAndExit);
    process.once("SIGINT", closeAndExit);
  }

  return _db;
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export interface AuditLogRow {
  action: string;
  target: string;
  ts: string;
  operator: string;
  agoSecs: number;
  detailsJson: string;
}

export function readLastAuditLog(action: string): AuditLogRow | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT action, target, ts, operator, details_json FROM audit_log WHERE action = ? ORDER BY ts DESC LIMIT 1"
    )
    .get(action) as
    | { action: string; target: string; ts: string; operator: string; details_json: string }
    | undefined;

  if (!row) return null;
  const agoSecs = Math.round((Date.now() - new Date(row.ts).getTime()) / 1000);
  return {
    action: row.action,
    target: row.target,
    ts: row.ts,
    operator: row.operator,
    agoSecs,
    detailsJson: row.details_json,
  };
}

export async function appendAuditLog(entry: {
  operator: string;
  action: string;
  target: string;
  detailsJson: string;
}): Promise<void> {
  const db = getDb();
  const row = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...entry,
  };
  db.prepare(
    "INSERT INTO audit_log (id, ts, operator, action, target, details_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.ts, row.operator, row.action, row.target, row.detailsJson);
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

export function saveProfile(profile: DemoProfile, savedBy: string): void {
  const validated = DemoProfileSchema.parse(profile);
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO profiles (name, saved_at, saved_by, payload_json) VALUES (?, ?, ?, ?)"
  ).run(
    validated.name,
    new Date().toISOString(),
    savedBy,
    JSON.stringify(validated)
  );
}

export function listProfiles(): Array<{
  name: string;
  savedAt: string;
  savedBy: string;
}> {
  const db = getDb();
  const rows = db
    .prepare("SELECT name, saved_at, saved_by FROM profiles ORDER BY saved_at DESC")
    .all() as Array<{ name: string; saved_at: string; saved_by: string }>;
  return rows.map(({ name, saved_at, saved_by }) => ({
    name,
    savedAt: saved_at,
    savedBy: saved_by,
  }));
}

export function loadProfile(name: string): DemoProfile | null {
  const db = getDb();
  const row = db
    .prepare("SELECT payload_json FROM profiles WHERE name = ?")
    .get(name) as { payload_json: string } | undefined;
  if (!row) return null;
  return DemoProfileSchema.parse(JSON.parse(row.payload_json));
}

// ─── SG whitelist ─────────────────────────────────────────────────────────────

export function listSgEntries(): SgWhitelistEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, cidr, label, added_by, added_at, port FROM sg_whitelist ORDER BY added_at DESC"
    )
    .all() as Array<{
      id: string;
      cidr: string;
      label: string;
      added_by: string;
      added_at: string;
      port: number;
    }>;
  return rows.map((r) =>
    SgWhitelistEntrySchema.parse({
      id: r.id,
      cidr: r.cidr,
      label: r.label,
      addedBy: r.added_by,
      addedAt: r.added_at,
      port: r.port as 8800,
    })
  );
}

export function upsertSgEntry(entry: SgWhitelistEntry): void {
  const validated = SgWhitelistEntrySchema.parse(entry);
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO sg_whitelist (id, cidr, label, added_by, added_at, port) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    validated.id,
    validated.cidr,
    validated.label,
    validated.addedBy,
    validated.addedAt,
    validated.port
  );
}

export function deleteSgEntry(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM sg_whitelist WHERE id = ?").run(id);
}

// ─── Camera overrides ─────────────────────────────────────────────────────────

export interface CameraOverrideRow {
  cameraId: string;
  /** null = no scenarioIds override stored; [] = explicit suppression. */
  scenarioIds: string[] | null;
  recordingEnabled: boolean | null;
  recordingPolicy: "always" | "event-only" | "off" | null;
  recordingRetentionDays: number | null;
  updatedAt: string;
  updatedBy: string;
}

export function getCameraOverride(cameraId: string): CameraOverrideRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT camera_id, scenario_ids, recording_enabled, recording_policy,
              recording_retention_days, updated_at, updated_by
       FROM camera_overrides WHERE camera_id = ?`
    )
    .get(cameraId) as
    | {
        camera_id: string;
        scenario_ids: string | null;
        recording_enabled: number | null;
        recording_policy: string | null;
        recording_retention_days: number | null;
        updated_at: string;
        updated_by: string;
      }
    | undefined;

  if (!row) return null;

  return {
    cameraId: row.camera_id,
    scenarioIds: row.scenario_ids !== null ? (JSON.parse(row.scenario_ids) as string[]) : null,
    recordingEnabled: row.recording_enabled !== null ? row.recording_enabled !== 0 : null,
    recordingPolicy: (row.recording_policy as CameraOverrideRow["recordingPolicy"]) ?? null,
    recordingRetentionDays: row.recording_retention_days,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function listCameraOverrides(): CameraOverrideRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT camera_id, scenario_ids, recording_enabled, recording_policy,
              recording_retention_days, updated_at, updated_by
       FROM camera_overrides ORDER BY camera_id`
    )
    .all() as Array<{
      camera_id: string;
      scenario_ids: string | null;
      recording_enabled: number | null;
      recording_policy: string | null;
      recording_retention_days: number | null;
      updated_at: string;
      updated_by: string;
    }>;

  return rows.map((row) => ({
    cameraId: row.camera_id,
    scenarioIds: row.scenario_ids !== null ? (JSON.parse(row.scenario_ids) as string[]) : null,
    recordingEnabled: row.recording_enabled !== null ? row.recording_enabled !== 0 : null,
    recordingPolicy: (row.recording_policy as CameraOverrideRow["recordingPolicy"]) ?? null,
    recordingRetentionDays: row.recording_retention_days,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }));
}

export function upsertCameraOverride(row: CameraOverrideRow): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO camera_overrides
       (camera_id, scenario_ids, recording_enabled, recording_policy,
        recording_retention_days, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.cameraId,
    row.scenarioIds !== null ? JSON.stringify(row.scenarioIds) : null,
    row.recordingEnabled !== null ? (row.recordingEnabled ? 1 : 0) : null,
    row.recordingPolicy,
    row.recordingRetentionDays,
    row.updatedAt,
    row.updatedBy,
  );
}

export function deleteCameraOverride(cameraId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM camera_overrides WHERE camera_id = ?").run(cameraId);
}

// ─── Rotation tracking ────────────────────────────────────────────────────────

export function getRotationAge(key: string): number | null {
  const db = getDb();
  const row = db
    .prepare("SELECT rotated_at FROM rotations WHERE key = ?")
    .get(key) as { rotated_at: string } | undefined;
  if (!row) return null;
  return Date.now() - new Date(row.rotated_at).getTime();
}

export function markRotated(key: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO rotations (key, rotated_at) VALUES (?, ?)"
  ).run(key, new Date().toISOString());
}
