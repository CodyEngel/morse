import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * Agent records moved from SQLite rows to files in 0.3.0. Nothing else in the
 * suite covers the seam, because from the outside the behaviour is meant to be
 * identical — which is exactly why it needs its own tests: a silent failure
 * here looks like "the upgrade ate my room".
 */
const tmp = mkdtempSync(join(tmpdir(), "morse-migrate-"));
process.env.MORSE_DB = join(tmp, "first.db");

const { Morse, resetDb, sanitizeRoom, FileRegistry, registryRoot } = await import(
  "../packages/morse-ai/dist/index.js"
);

after(() => {
  resetDb();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A database shaped the way morse 0.2.0 left it, in a directory of its own.
 *
 * Its own directory matters: records live beside the store, so two suites
 * pointing MORSE_DB at different files in the same folder would share a
 * registry — and the second would find the first's records already there and
 * skip the import it was trying to test.
 */
function legacyRoom({ room, agents, messages = 0 }) {
  resetDb();
  const dir = mkdtempSync(join(tmp, "case-"));
  const path = join(dir, "legacy.db");
  process.env.MORSE_DB = path;
  buildLegacyDb(path, { room, agents, messages });
  return path;
}

function buildLegacyDb(path, { room, agents, messages }) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE agents (room TEXT NOT NULL, name TEXT NOT NULL, role TEXT, description TEXT,
    skills TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'idle', status_note TEXT,
    harness TEXT, pid INTEGER, cwd TEXT, cursor INTEGER NOT NULL DEFAULT 0,
    present INTEGER NOT NULL DEFAULT 1, joined_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    PRIMARY KEY (room, name))`);
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL,
    thread_id TEXT NOT NULL, reply_to INTEGER, sender TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
    subject TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE deliveries (message_id INTEGER NOT NULL, room TEXT NOT NULL,
    recipient TEXT NOT NULL, PRIMARY KEY (message_id, recipient))`);

  const now = Date.now();
  const insert = db.prepare(`INSERT INTO agents
    (room,name,role,description,skills,status,status_note,harness,pid,cwd,cursor,present,joined_at,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const a of agents) {
    insert.run(room, a.name, a.role ?? null, a.description ?? null, JSON.stringify(a.skills ?? []),
      a.status ?? "idle", a.statusNote ?? null, a.harness ?? null, a.pid ?? null, a.cwd ?? null,
      a.cursor ?? 0, a.present ?? 1, now, now);
  }
  for (let i = 0; i < messages; i++) {
    db.prepare(`INSERT INTO messages (room,thread_id,reply_to,sender,kind,subject,body,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(room, "t-legacy", null, "someone", "message", null, `body ${i}`, now);
    db.prepare(`INSERT INTO deliveries (message_id, room, recipient) VALUES (?,?,?)`)
      .run(i + 1, room, agents[0].name);
  }
  db.close();
}

test("a 0.2 room is imported on a read, not only on a join", () => {
  // The failure this guards is specific: hang the import off register() and
  // `morse roster` on an upgraded room shows nothing at all.
  legacyRoom({
    room: "old",
    agents: [
      { name: "backend", role: "Backend Engineer", skills: ["sql", "api"], status: "working", statusNote: "on it", harness: "claude-code", pid: process.pid },
      { name: "gone", status: "done", present: 0 },
    ],
  });

  const roster = new Morse().roster("old");
  assert.equal(roster.length, 2);

  const backend = roster.find((a) => a.name === "backend");
  assert.equal(backend.role, "Backend Engineer");
  assert.deepEqual(backend.skills, ["sql", "api"]);
  assert.equal(backend.status, "working");
  assert.equal(backend.statusNote, "on it");
  assert.equal(backend.harness, "claude-code");
  assert.equal(backend.alive, true, "a live pid should still read as alive after the move");

  const gone = roster.find((a) => a.name === "gone");
  assert.equal(gone.online, false, "present=0 must survive as departed");
  assert.equal(gone.status, "done", "and how the work ended must survive with it");
});

test("the read cursor survives the move, so no mail is redelivered or lost", () => {
  legacyRoom({ room: "old", agents: [{ name: "backend", cursor: 7 }], messages: 9 });

  const store = new Morse();
  // Nine delivered, read up to 7: two outstanding. Drop the cursor and this
  // agent is handed its whole history again; reset it to the high-water mark
  // and the two it never saw are gone for good.
  assert.equal(store.unreadCount("old", "backend"), 2);
  assert.equal(store.inbox("old", "backend").length, 2);
  assert.equal(store.unreadCount("old", "backend"), 0, "reading advances it as usual");
});

test("importing is idempotent and leaves the legacy table alone", () => {
  const db = legacyRoom({ room: "old", agents: [{ name: "backend", cursor: 4 }], messages: 6 });

  assert.equal(new Morse().roster("old").length, 1);
  const second = new Morse();
  assert.equal(second.roster("old").length, 1, "a second process must not double-import");
  assert.equal(second.unreadCount("old", "backend"), 2, "nor reset the cursor it already carried");

  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const raw = new DatabaseSync(db);
  const remaining = Number(raw.prepare("SELECT COUNT(*) AS n FROM agents").get().n);
  raw.close();
  assert.equal(remaining, 1, "the legacy rows are read, never dropped — a 0.2 morse may still want them");
});

test("records live beside the store rather than splitting state across two homes", () => {
  // Only MORSE_DB is set, which is what every other suite here does. If the
  // registry ignored it the records would land in the real ~/.morse while the
  // messages went to a temp dir.
  resetDb();
  process.env.MORSE_DB = join(mkdtempSync(join(tmp, "case-")), "beside.db");
  const root = registryRoot();
  assert.ok(root.startsWith(tmp), `expected the registry under ${tmp}, got ${root}`);
  assert.ok(!root.startsWith(join(homedir(), ".morse")), "must not fall back to the real home");

  new Morse().register({ room: "vroom", name: "backend", skills: ["sql"] });
  const file = join(root, "vroom", "agents", "backend.json");
  assert.ok(existsSync(file), `expected a record at ${file}`);
  // Same reasoning as the message store: everything agents publish is plaintext.
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "vroom", "agents")).mode & 0o777, 0o700);
});

test("a room name cannot climb out of the rooms directory", () => {
  // Harmless while the room was only ever a SQL value; it is a path component
  // now. `MORSE_ROOM=..` would otherwise resolve to ~/.morse itself.
  for (const escape of ["..", "  ..  ", "-..-", ".", "...."]) {
    assert.equal(sanitizeRoom(escape), "default", `${JSON.stringify(escape)} should be refused`);
  }
  assert.equal(sanitizeRoom("app"), "app");
  assert.equal(sanitizeRoom("my.repo-2"), "my.repo-2", "dots are still legal inside a name");
});

test("an agent name cannot climb out either", () => {
  const registry = new FileRegistry(join(tmp, "escape-check"));
  for (const escape of ["../escape", "..", "/etc/passwd"]) {
    assert.throws(
      () => registry.publish({ room: "r", name: escape }),
      /Invalid agent name/,
      `${JSON.stringify(escape)} should be refused`,
    );
  }
  // Reads are forgiving where writes are strict: an unnameable agent is simply
  // not there, and a roster must not throw because someone typed nonsense.
  assert.equal(registry.get("r", "../x"), undefined);
});
