// SQLite-backed persistence layer for MEET-API. Single-process, single-file,
// synchronous. Loaded once at process start; no connection pooling because
// better-sqlite3 is sync and the process is single-threaded.
//
// Layout:
//   ${MEET_DATA_DIR:-/data}/meet.db        — primary database
//   ${MEET_DATA_DIR:-/data}/meet.db-wal    — WAL (created automatically)
//   ${MEET_DATA_DIR:-/data}/meet.db-shm    — shared-memory (created automatically)
//
// In the external-proxy compose stack, /data is a named volume so the file
// survives `docker compose down && up`. WAL mode is on for crash safety
// without paying fsync per write.
//
// Migrations are forward-only and run at startup inside a transaction.
// Add a new entry to MIGRATIONS to evolve the schema; never edit a past
// migration in place.

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DATA_DIR = process.env.MEET_DATA_DIR || '/data';
const DB_PATH = path.join(DATA_DIR, 'meet.db');

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL'); // WAL + NORMAL is safe across crashes

  runMigrations(db);
  dbInstance = db;
  console.log(`[db] opened ${DB_PATH} (schema v${currentSchemaVersion(db)})`);
  return db;
}

const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // v1 — initial schema.
  (db) => {
    db.exec(`
      CREATE TABLE api_keys (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        key           TEXT NOT NULL,
        key_hash      TEXT NOT NULL,
        permissions   TEXT NOT NULL,    -- JSON array
        created_at    TEXT NOT NULL,    -- ISO 8601
        last_used_at  TEXT              -- ISO 8601 or NULL
      );
      CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);

      CREATE TABLE webhooks (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        url               TEXT NOT NULL,
        events            TEXT NOT NULL,    -- JSON array
        enabled           INTEGER NOT NULL, -- 0/1
        secret            TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        last_triggered_at TEXT,
        failure_count     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL                 -- JSON-encoded value
      );

      -- Single-row table; id is always 1.
      CREATE TABLE admin_credentials (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        username          TEXT NOT NULL DEFAULT '',
        password          TEXT NOT NULL DEFAULT '',
        first_login_done  INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO admin_credentials (id) VALUES (1);
    `);
  },
];

function currentSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT version FROM schema_version LIMIT 1')
    .get() as { version: number } | undefined;
  return row?.version ?? 0;
}

function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
  const start = currentSchemaVersion(db);

  for (let i = start; i < MIGRATIONS.length; i++) {
    const target = i + 1;
    const migrate = MIGRATIONS[i];
    db.transaction(() => {
      migrate(db);
      db.prepare('DELETE FROM schema_version').run();
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(target);
    })();
    console.log(`[db] migrated to schema v${target}`);
  }
}
