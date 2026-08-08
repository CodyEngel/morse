import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Loaded through require rather than a static import on purpose: ESM links
// builtins before any module body runs, which would fire node:sqlite's
// experimental warning before warnings.ts had a chance to silence it. require
// resolves at evaluation time instead, which is after.
const { DatabaseSync: Database } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

/** Machine-wide store. Rooms partition it; see room.ts. */
export function dbPath(): string {
  if (process.env.MORSE_DB) return process.env.MORSE_DB;
  const home = process.env.MORSE_HOME ?? join(homedir(), ".morse");
  return join(home, "morse.db");
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (
     name        TEXT PRIMARY KEY,
     topic       TEXT,
     created_at  INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS agents (
     room        TEXT NOT NULL,
     name        TEXT NOT NULL,
     role        TEXT,
     description TEXT,
     skills      TEXT NOT NULL DEFAULT '[]',
     status      TEXT NOT NULL DEFAULT 'idle',
     status_note TEXT,
     harness     TEXT,
     pid         INTEGER,
     cwd         TEXT,
     cursor      INTEGER NOT NULL DEFAULT 0,
     present     INTEGER NOT NULL DEFAULT 1,
     joined_at   INTEGER NOT NULL,
     last_seen   INTEGER NOT NULL,
     PRIMARY KEY (room, name)
   )`,

  `CREATE TABLE IF NOT EXISTS messages (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     room       TEXT NOT NULL,
     thread_id  TEXT NOT NULL,
     reply_to   INTEGER,
     sender     TEXT NOT NULL,
     kind       TEXT NOT NULL DEFAULT 'message',
     subject    TEXT,
     body       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,

  // One row per addressee. Broadcasts use the literal recipient '*' so that a
  // single row serves every present and future member of the room.
  `CREATE TABLE IF NOT EXISTS deliveries (
     message_id INTEGER NOT NULL,
     room       TEXT NOT NULL,
     recipient  TEXT NOT NULL,
     PRIMARY KEY (message_id, recipient)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages (room, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (room, thread_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_recipient ON deliveries (room, recipient, message_id)`,
];

/** Applied on top of SCHEMA for databases created by an earlier version. */
const ADDITIONS = [`ALTER TABLE agents ADD COLUMN present INTEGER NOT NULL DEFAULT 1`];

let cached: DatabaseSync | undefined;

export function openDb(path = dbPath()): DatabaseSync {
  if (cached) return cached;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);

  // busy_timeout first, so every statement after it waits on a lock instead of
  // failing outright.
  db.exec("PRAGMA busy_timeout = 5000");
  enableWal(db);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  cached = db;
  return db;
}

/**
 * Switching a database into WAL needs a brief exclusive lock, and busy_timeout
 * does NOT cover that transition — SQLite returns BUSY immediately. Six agents
 * opening a cold database at once means several lose that race.
 *
 * WAL is a persistent property of the file, so only the very first process has
 * real work to do here; everyone else finds it already set. If we still lose,
 * fall back to the default journal mode rather than killing the agent: slower
 * under contention, but busy_timeout keeps it correct.
 */
function enableWal(db: DatabaseSync, attempts = 8): void {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const [row] = db.prepare("PRAGMA journal_mode").all() as { journal_mode?: string }[];
      if (String(row?.journal_mode ?? "").toLowerCase() === "wal") return;
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isContention(error) || attempt === attempts) return;
      sleepSync(backoff(attempt));
    }
  }
}

/**
 * Concurrent `CREATE TABLE IF NOT EXISTS` from separate processes can still
 * collide, so retry before giving up. Unlike the WAL switch this one is fatal:
 * without the schema there is no bus.
 */
function migrate(db: DatabaseSync, attempts = 8): void {
  for (let attempt = 1; ; attempt++) {
    try {
      for (const stmt of SCHEMA) db.exec(stmt);
      for (const stmt of ADDITIONS) {
        try {
          db.exec(stmt);
        } catch (error) {
          // Already applied, which is the normal case.
          if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error;
        }
      }
      return;
    } catch (error) {
      if (!isContention(error) || attempt >= attempts) throw error;
      sleepSync(backoff(attempt));
    }
  }
}

function isContention(error: unknown): boolean {
  return /busy|locked/i.test(error instanceof Error ? error.message : String(error));
}

/** Jittered, so six processes that collide do not retry in lockstep forever. */
function backoff(attempt: number): number {
  return Math.round(15 * attempt * (1 + Math.random()));
}

/** Blocking sleep: openDb is synchronous and runs before any event loop work. */
function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/** Test helper: drop the process-wide handle so a new path can be opened. */
export function resetDb(): void {
  cached?.close();
  cached = undefined;
}

export function now(): number {
  return Date.now();
}
