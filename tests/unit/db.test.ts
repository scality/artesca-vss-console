import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";

// In-memory SQLite — mirrors db.ts schema but does not import server-only
function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      name         TEXT PRIMARY KEY,
      saved_at     TEXT NOT NULL,
      saved_by     TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id           TEXT PRIMARY KEY,
      ts           TEXT NOT NULL,
      operator     TEXT NOT NULL,
      action       TEXT NOT NULL,
      target       TEXT NOT NULL,
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
  return db;
}

describe("db schema — profiles", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("saves and loads a profile", () => {
    const payload = JSON.stringify({ name: "test-profile", scenarios: [] });
    db.prepare("INSERT INTO profiles (name, saved_at, saved_by, payload_json) VALUES (?, ?, ?, ?)")
      .run("test-profile", new Date().toISOString(), "op", payload);

    const row = db.prepare("SELECT payload_json FROM profiles WHERE name = ?").get("test-profile") as { payload_json: string };
    expect(row).toBeTruthy();
    expect(JSON.parse(row.payload_json).name).toBe("test-profile");
  });

  it("lists profiles ordered by saved_at desc", () => {
    db.prepare("INSERT INTO profiles (name, saved_at, saved_by, payload_json) VALUES (?, ?, ?, ?)")
      .run("older", "2026-04-01T00:00:00.000Z", "op", "{}");
    db.prepare("INSERT INTO profiles (name, saved_at, saved_by, payload_json) VALUES (?, ?, ?, ?)")
      .run("newer", "2026-04-22T00:00:00.000Z", "op", "{}");

    const rows = db.prepare("SELECT name FROM profiles ORDER BY saved_at DESC").all() as Array<{ name: string }>;
    expect(rows[0].name).toBe("newer");
    expect(rows[1].name).toBe("older");
  });

  it("INSERT OR REPLACE updates existing profile", () => {
    db.prepare("INSERT INTO profiles (name, saved_at, saved_by, payload_json) VALUES (?, ?, ?, ?)")
      .run("dup", "2026-04-01T00:00:00.000Z", "op", '{"v":1}');
    db.prepare("INSERT OR REPLACE INTO profiles (name, saved_at, saved_by, payload_json) VALUES (?, ?, ?, ?)")
      .run("dup", "2026-04-22T00:00:00.000Z", "op", '{"v":2}');

    const row = db.prepare("SELECT payload_json FROM profiles WHERE name = ?").get("dup") as { payload_json: string };
    expect(JSON.parse(row.payload_json).v).toBe(2);
  });
});

describe("db schema — audit_log", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("appends and reads audit log entries", () => {
    const id = randomUUID();
    db.prepare("INSERT INTO audit_log (id, ts, operator, action, target, details_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, new Date().toISOString(), "op", "sg.add", "84.14.13.200/29", "{}");

    const row = db.prepare("SELECT * FROM audit_log WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.action).toBe("sg.add");
    expect(row.target).toBe("84.14.13.200/29");
  });

  it("multiple entries accumulate", () => {
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO audit_log (id, ts, operator, action, target, details_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), new Date().toISOString(), "op", `action.${i}`, "target", "{}");
    }
    const count = (db.prepare("SELECT COUNT(*) as c FROM audit_log").get() as { c: number }).c;
    expect(count).toBe(5);
  });
});

describe("db schema — sg_whitelist CRUD", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  const entry = {
    id: "550e8400-e29b-41d4-a716-446655440001",
    cidr: "84.14.13.200/29",
    label: "Scality Paris office",
    added_by: "op",
    added_at: "2026-04-01T09:00:00.000Z",
    port: 8800,
  };

  it("inserts and reads an SG entry", () => {
    db.prepare("INSERT INTO sg_whitelist (id, cidr, label, added_by, added_at, port) VALUES (?, ?, ?, ?, ?, ?)")
      .run(entry.id, entry.cidr, entry.label, entry.added_by, entry.added_at, entry.port);

    const row = db.prepare("SELECT * FROM sg_whitelist WHERE id = ?").get(entry.id) as typeof entry;
    expect(row.cidr).toBe("84.14.13.200/29");
    expect(row.port).toBe(8800);
  });

  it("deletes an SG entry", () => {
    db.prepare("INSERT INTO sg_whitelist (id, cidr, label, added_by, added_at, port) VALUES (?, ?, ?, ?, ?, ?)")
      .run(entry.id, entry.cidr, entry.label, entry.added_by, entry.added_at, entry.port);
    db.prepare("DELETE FROM sg_whitelist WHERE id = ?").run(entry.id);

    const row = db.prepare("SELECT * FROM sg_whitelist WHERE id = ?").get(entry.id);
    expect(row).toBeUndefined();
  });
});

describe("db schema — rotation age", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("returns undefined for never-rotated key", () => {
    const row = db.prepare("SELECT rotated_at FROM rotations WHERE key = ?").get("ngc-key");
    expect(row).toBeUndefined();
  });

  it("stores rotation timestamp and computes age", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT OR REPLACE INTO rotations (key, rotated_at) VALUES (?, ?)").run("ngc-key", now);

    const row = db.prepare("SELECT rotated_at FROM rotations WHERE key = ?").get("ngc-key") as { rotated_at: string };
    const age = Date.now() - new Date(row.rotated_at).getTime();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(5000);
  });

  it("INSERT OR REPLACE updates rotation timestamp", () => {
    db.prepare("INSERT OR REPLACE INTO rotations (key, rotated_at) VALUES (?, ?)").run("key", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT OR REPLACE INTO rotations (key, rotated_at) VALUES (?, ?)").run("key", "2026-04-22T00:00:00.000Z");

    const row = db.prepare("SELECT rotated_at FROM rotations WHERE key = ?").get("key") as { rotated_at: string };
    expect(row.rotated_at).toBe("2026-04-22T00:00:00.000Z");
  });
});
