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

function dbPath(): string {
  const dir = process.env.CONSOLE_DATA_DIR ?? "/data";
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "console-data.db");
}

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(dbPath());
  _db.pragma("journal_mode = WAL");

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
  `);

  return _db;
}

// ─── Audit log ────────────────────────────────────────────────────────────────

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
