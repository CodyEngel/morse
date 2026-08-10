import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeRoom } from "./room.js";

/**
 * The registry is plain files, one per agent, because every agent record has
 * exactly one writer: the agent's own process. Nothing here needs a database —
 * see docs/plans/multi-package-split.md, Decision 1.
 *
 *   ~/.morse/rooms/<room>/agents/<name>.json
 *
 * `last_seen` is the file's mtime rather than a field, so a heartbeat is a
 * `utimes` call instead of a rewrite. That matters: the bus heartbeats every
 * 200ms per agent while parked.
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "offline";

/** An agent is considered present if it has touched the registry this recently. */
export const ONLINE_WINDOW_MS = 90_000;

export interface Agent {
  room: string;
  name: string;
  role: string | null;
  description: string | null;
  skills: string[];
  status: AgentStatus;
  statusNote: string | null;
  harness: string | null;
  pid: number | null;
  cwd: string | null;
  joinedAt: number;
  lastSeen: number;
  /** Heartbeating: in the wait loop and listening right now. */
  online: boolean;
  /** Process still exists, even if it has not touched the registry recently. */
  alive: boolean;
}

export interface PublishInput {
  room: string;
  name: string;
  role?: string;
  description?: string;
  skills?: string[];
  harness?: string;
  pid?: number;
  cwd?: string;
}

/** What actually lands on disk. `lastSeen` is absent on purpose; it is the mtime. */
interface Record {
  name: string;
  role: string | null;
  description: string | null;
  skills: string[];
  status: AgentStatus;
  statusNote: string | null;
  harness: string | null;
  pid: number | null;
  cwd: string | null;
  joinedAt: number;
  present: boolean;
}

/**
 * An agent name becomes a filename, so it must not be able to become a path.
 * Same rule role names already obey, applied to identity: `../../../etc/passwd`
 * would otherwise be a legal agent name.
 */
export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name.trim().toLowerCase()) && !name.includes("..");
}

/**
 * Where agent records live.
 *
 * `MORSE_DB` is the fallback rather than an afterthought: it is the documented
 * way to relocate morse's state, and splitting that state — messages in the
 * directory you named, records back in your home directory — would be a
 * surprise with no upside. Relocate the store and the records follow it.
 */
export function registryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.MORSE_HOME ?? (env.MORSE_DB ? dirname(env.MORSE_DB) : join(homedir(), ".morse"));
  return join(home, "rooms");
}

export class FileRegistry {
  constructor(private readonly root: string = registryRoot()) {}

  // ----------------------------------------------------------------- paths

  private roomDir(room: string): string {
    // Sanitised, not trusted: the room name arrives from $MORSE_ROOM or --room
    // and is now a path component rather than a SQL value.
    return join(this.root, sanitizeRoom(room), "agents");
  }

  private recordPath(room: string, name: string): string {
    const clean = name.trim().toLowerCase();
    if (!isValidAgentName(clean)) {
      throw new Error(
        `Invalid agent name '${name}'. Use letters, digits, dot, dash or underscore — it becomes a filename.`,
      );
    }
    return join(this.roomDir(room), `${clean}.json`);
  }

  // ------------------------------------------------------------------ read

  get(room: string, name: string): Agent | undefined {
    let path: string;
    try {
      path = this.recordPath(room, name);
    } catch {
      return undefined; // An unnameable agent is simply not there.
    }
    return this.read(room, path);
  }

  list(room: string): Agent[] {
    const dir = this.roomDir(room);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return []; // A room nobody has joined is empty, not an error.
    }
    const agents: Agent[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const agent = this.read(room, join(dir, entry));
      if (agent) agents.push(agent);
    }
    // Joined order, so the roster reads the way the room filled up.
    return agents.sort((a, b) => a.joinedAt - b.joinedAt || a.name.localeCompare(b.name));
  }

  /** Just the names. All the bus needs, and it has no business reading more. */
  names(room: string): string[] {
    return this.list(room).map((agent) => agent.name);
  }

  status(room: string, name: string): AgentStatus | undefined {
    return this.get(room, name)?.status;
  }

  listRooms(): { name: string; agents: number }[] {
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch {
      return [];
    }
    const rooms: { name: string; agents: number }[] = [];
    for (const entry of entries.sort()) {
      const agents = this.list(entry).length;
      rooms.push({ name: entry, agents });
    }
    return rooms;
  }

  // ----------------------------------------------------------------- write

  /**
   * Publish who this agent is and what it is for.
   *
   * Returns whether the record was newly created, because that is a different
   * event from a reconnect and the caller may need to say so out loud.
   * Re-publishing merges: a field the caller says nothing about keeps whatever
   * was there, which is what makes a partial update from one call site safe.
   */
  publish(input: PublishInput): { agent: Agent; firstTime: boolean } {
    const path = this.recordPath(input.room, input.name);
    const existing = this.readRecord(path);
    const now = Date.now();

    const record: Record = existing
      ? {
          name: existing.name,
          role: input.role ?? existing.role,
          description: input.description ?? existing.description,
          skills: input.skills ?? existing.skills,
          // Coming back means there is more to do, so a terminal status from the
          // previous session must not linger and fake convergence.
          status: existing.status === "offline" || existing.status === "done" ? "idle" : existing.status,
          statusNote: existing.statusNote,
          harness: input.harness ?? existing.harness,
          pid: input.pid ?? existing.pid,
          cwd: input.cwd ?? existing.cwd,
          joinedAt: existing.joinedAt,
          present: true,
        }
      : {
          name: input.name.trim().toLowerCase(),
          role: input.role ?? null,
          description: input.description ?? null,
          skills: input.skills ?? [],
          status: "idle",
          statusNote: null,
          harness: input.harness ?? null,
          pid: input.pid ?? null,
          cwd: input.cwd ?? null,
          joinedAt: now,
          present: true,
        };

    this.write(path, record);
    return { agent: this.read(input.room, path)!, firstTime: !existing };
  }

  setStatus(room: string, name: string, status: AgentStatus, note?: string | null): void {
    const path = this.recordPath(room, name);
    const existing = this.readRecord(path);
    if (!existing) return;
    this.write(path, { ...existing, status, statusNote: note ?? null });
  }

  /**
   * Note that this agent is alive right now.
   *
   * `utimes` rather than a rewrite: the bus calls this on every poll of a
   * parked wait, so it has to cost nothing. Measured at ~5µs.
   */
  heartbeat(room: string, name: string): void {
    let path: string;
    try {
      path = this.recordPath(room, name);
    } catch {
      return;
    }
    const when = Date.now() / 1000;
    try {
      utimesSync(path, when, when);
    } catch {
      // Not registered, or gone. A heartbeat for someone who is not there is a
      // no-op, not an error — the bus must never fail a wait over this.
    }
  }

  /**
   * Departure clears presence but leaves `status` alone.
   *
   * Presence and status answer different questions — "is anyone there" versus
   * "how did their work end" — and overwriting status on the way out destroys
   * the only record of the second. A room where everyone finished then looked
   * identical to one where everyone crashed, which is precisely the case a
   * human needs to tell apart after the processes are gone.
   */
  depart(room: string, name: string): void {
    const path = this.recordPath(room, name);
    const existing = this.readRecord(path);
    if (!existing) return;
    this.write(path, { ...existing, present: false });
  }

  forgetRoom(room: string): void {
    rmSync(join(this.root, sanitizeRoom(room)), { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ disk

  /**
   * The record exactly as stored. Read-modify-write goes through this rather
   * than through `Agent`, because `Agent` reports `online`/`alive` — derived
   * views of `present` — and round-tripping a derived value back into storage
   * loses the thing it was derived from.
   */
  private readRecord(path: string): Record | undefined {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
    try {
      const record = JSON.parse(raw) as Record;
      if (!record || typeof record.name !== "string") return undefined;
      return record;
    } catch {
      // A record that does not parse is not a crash. It is one agent missing
      // from a roster, and `morse roster` showing five of six beats it showing
      // a stack trace.
      return undefined;
    }
  }

  private read(room: string, path: string): Agent | undefined {
    const record = this.readRecord(path);
    if (!record) return undefined;

    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return undefined;
    }

    const status = (record.status ?? "idle") as AgentStatus;
    const present = record.present !== false;
    return {
      room,
      name: record.name,
      role: record.role ?? null,
      description: record.description ?? null,
      skills: Array.isArray(record.skills) ? record.skills.map(String) : [],
      status,
      statusNote: record.statusNote ?? null,
      harness: record.harness ?? null,
      pid: record.pid ?? null,
      cwd: record.cwd ?? null,
      joinedAt: Number(record.joinedAt ?? mtime),
      lastSeen: mtime,
      online: present && status !== "offline" && Date.now() - mtime < ONLINE_WINDOW_MS,
      alive: present && isRunning(record.pid ?? null),
    };
  }

  /**
   * Write whole, then rename into place.
   *
   * Rename is atomic on a local filesystem, so a reader mid-write sees the old
   * record or the new one and never a truncated one. Records are what agents
   * publish about themselves in plaintext, so they get the same 0600 the
   * message store gets.
   */
  private write(path: string, record: Record): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    try {
      renameSync(temp, path);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // Best effort; the rename failure is the interesting one.
      }
      throw error;
    }
    restrict(path, dir);
  }
}

/**
 * Distinguishes a session that is up but not listening from one that is gone.
 *
 * A harness only acts on its turn, so an agent that has been launched but not
 * yet prompted registers once and then goes quiet. Judged on heartbeat alone it
 * looks identical to a crashed process — but its inbox is still filling up, and
 * a teammate needs to know the difference between "nobody is there" and "they
 * just have not looked yet". The registry is machine-wide, so the pid is local.
 */
export function isRunning(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Same reasoning as the message store's permissions: see SECURITY.md. */
function restrict(path: string, dir: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // A record owned by someone else is their business, not ours.
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A shared parent directory is the operator's choice.
  }
}
