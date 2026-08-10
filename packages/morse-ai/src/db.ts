import type { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
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

// `rooms` and `agents` are deliberately absent: agent records are files owned
// by @morse-ai/registry, and a room is a directory. Databases written by an
// earlier morse still have both tables and they are never dropped — Store
// reads them once per room to import, and otherwise leaves them alone.
const SCHEMA = [
  // A read high-water mark is a property of a mailbox, not of an identity,
  // which is why this stayed behind when the agent record left.
  `CREATE TABLE IF NOT EXISTS cursors (
     room   TEXT NOT NULL,
     name   TEXT NOT NULL,
     cursor INTEGER NOT NULL DEFAULT 0,
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

/**
 * Applied on top of SCHEMA for databases created by an earlier version.
 *
 * Empty since 0.3.0: the columns this used to add belong to the legacy `agents`
 * table, which is no longer written. Kept rather than deleted because the
 * migration discipline it encodes — additive only, never destructive — is the
 * reason a 0.2 store and a 0.3 store can share a machine.
 */
const ADDITIONS: string[] = [];

let cached: DatabaseSync | undefined;

export function openDb(path = dbPath()): DatabaseSync {
  if (cached) return cached;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const db = new Database(path);
  if (path !== ":memory:") restrictPermissions(path);

  // busy_timeout first, so every statement after it waits on a lock instead of
  // failing outright.
  db.exec("PRAGMA busy_timeout = 5000");
  enableWal(db);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  // WAL sidecars only appear after the first write, so tighten them again now.
  if (path !== ":memory:") restrictPermissions(path);

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

/**
 * Keep the store readable only by its owner.
 *
 * Everything agents say to each other lands here in plaintext — repository
 * paths, working context, whatever they quote out of the codebase. SQLite
 * creates databases at the process umask, which on a typical machine leaves
 * them world-readable. This does not make the store a security boundary (any
 * process running as this user can still read it) but it stops other accounts
 * on a shared machine from reading the room. See SECURITY.md.
 */
function restrictPermissions(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // The sidecar files only exist once WAL is active, and a store owned by
      // someone else is their business, not ours.
    }
  }
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // Best effort; a shared parent directory is the operator's choice.
  }
}

/** Test helper: drop the process-wide handle so a new path can be opened. */
export function resetDb(): void {
  cached?.close();
  cached = undefined;
}

export function now(): number {
  return Date.now();
}
