import type { DatabaseSync } from "node:sqlite";
import { openDb, now } from "./db.js";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "offline";
export type MessageKind = "message" | "ask" | "reply" | "broadcast" | "system";

/** An agent is considered present if it has touched the bus this recently. */
export const ONLINE_WINDOW_MS = 90_000;

export const BROADCAST = "*";

export interface Message {
  id: number;
  room: string;
  threadId: string;
  replyTo: number | null;
  sender: string;
  kind: MessageKind;
  subject: string | null;
  body: string;
  createdAt: number;
  /** Who the message was addressed to; `['*']` for a broadcast. */
  to: string[];
}

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
  cursor: number;
  joinedAt: number;
  lastSeen: number;
  /** Heartbeating: in the wait loop and listening right now. */
  online: boolean;
  /** Process still exists, even if it has not touched the bus recently. */
  alive: boolean;
}

export interface RegisterInput {
  room: string;
  name: string;
  role?: string;
  description?: string;
  skills?: string[];
  harness?: string;
  pid?: number;
  cwd?: string;
}

export interface SendInput {
  room: string;
  sender: string;
  to: string[];
  body: string;
  subject?: string;
  kind?: MessageKind;
  threadId?: string;
  replyTo?: number;
}

type Row = Record<string, unknown>;

export class Store {
  constructor(private readonly db: DatabaseSync = openDb()) {}

  // ---------------------------------------------------------------- rooms

  ensureRoom(room: string, topic?: string): void {
    this.db
      .prepare(`INSERT INTO rooms (name, topic, created_at) VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET topic = COALESCE(excluded.topic, rooms.topic)`)
      .run(room, topic ?? null, now());
  }

  listRooms(): { name: string; topic: string | null; agents: number; messages: number }[] {
    const rows = this.db
      .prepare(
        `SELECT r.name, r.topic,
                (SELECT COUNT(*) FROM agents a WHERE a.room = r.name)   AS agents,
                (SELECT COUNT(*) FROM messages m WHERE m.room = r.name) AS messages
         FROM rooms r ORDER BY r.name`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      name: String(r.name),
      topic: (r.topic as string | null) ?? null,
      agents: Number(r.agents),
      messages: Number(r.messages),
    }));
  }

  // --------------------------------------------------------------- agents

  register(input: RegisterInput): Agent {
    const { room, name } = input;
    this.ensureRoom(room);
    const ts = now();
    const existing = this.getAgent(room, name);

    if (existing) {
      // Re-registering keeps the read cursor so a reconnecting agent does not
      // lose messages that arrived while it was away.
      this.db
        .prepare(
          `UPDATE agents SET
             role        = COALESCE(?, role),
             description = COALESCE(?, description),
             skills      = COALESCE(?, skills),
             harness     = COALESCE(?, harness),
             pid         = COALESCE(?, pid),
             cwd         = COALESCE(?, cwd),
             present     = 1,
             -- Coming back means there is more to do, so a terminal status from
             -- the previous session must not linger and fake convergence.
             status      = CASE WHEN status IN ('offline', 'done') THEN 'idle' ELSE status END,
             last_seen   = ?
           WHERE room = ? AND name = ?`,
        )
        .run(
          input.role ?? null,
          input.description ?? null,
          input.skills ? JSON.stringify(input.skills) : null,
          input.harness ?? null,
          input.pid ?? null,
          input.cwd ?? null,
          ts,
          room,
          name,
        );
    } else {
      // A first-time joiner starts at the current high-water mark rather than
      // being flooded with the room's backlog. `history` is there if it wants it.
      const cursor = this.maxMessageId(room);
      this.db
        .prepare(
          `INSERT INTO agents (room, name, role, description, skills, status, harness, pid, cwd, cursor, joined_at, last_seen)
           VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          room,
          name,
          input.role ?? null,
          input.description ?? null,
          JSON.stringify(input.skills ?? []),
          input.harness ?? null,
          input.pid ?? null,
          input.cwd ?? null,
          cursor,
          ts,
          ts,
        );
      this.systemMessage(room, `${name} joined the room.`);
    }

    return this.getAgent(room, name)!;
  }

  getAgent(room: string, name: string): Agent | undefined {
    const row = this.db.prepare(`SELECT * FROM agents WHERE room = ? AND name = ?`).get(room, name) as
      | Row
      | undefined;
    return row ? toAgent(row) : undefined;
  }

  roster(room: string): Agent[] {
    const rows = this.db
      .prepare(`SELECT * FROM agents WHERE room = ? ORDER BY joined_at`)
      .all(room) as Row[];
    return rows.map(toAgent);
  }

  /** Bump last_seen. Called on every tool invocation and every wait poll. */
  touch(room: string, name: string): void {
    this.db.prepare(`UPDATE agents SET last_seen = ? WHERE room = ? AND name = ?`).run(now(), room, name);
  }

  setStatus(room: string, name: string, status: AgentStatus, note?: string | null): void {
    this.db
      .prepare(`UPDATE agents SET status = ?, status_note = ?, last_seen = ? WHERE room = ? AND name = ?`)
      .run(status, note ?? null, now(), room, name);
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
  leave(room: string, name: string, announce = true): void {
    this.db
      .prepare(`UPDATE agents SET present = 0, last_seen = ? WHERE room = ? AND name = ?`)
      .run(now(), room, name);
    if (announce) this.systemMessage(room, `${name} left the room.`);
  }

  // ------------------------------------------------------------- messages

  send(input: SendInput): Message {
    const recipients = normalizeRecipients(input.to);
    if (recipients.length === 0) throw new Error("send requires at least one recipient");

    const kind: MessageKind = input.kind ?? (recipients.includes(BROADCAST) ? "broadcast" : "message");
    return this.insert(input, recipients, kind);
  }

  private insert(input: SendInput, recipients: string[], kind: MessageKind): Message {
    const { room, sender } = input;
    const ts = now();
    const threadId = input.threadId ?? newThreadId();

    const info = this.db
      .prepare(
        `INSERT INTO messages (room, thread_id, reply_to, sender, kind, subject, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(room, threadId, input.replyTo ?? null, sender, kind, input.subject ?? null, input.body, ts);

    const id = Number(info.lastInsertRowid);
    const insertDelivery = this.db.prepare(
      `INSERT OR IGNORE INTO deliveries (message_id, room, recipient) VALUES (?, ?, ?)`,
    );
    for (const recipient of recipients) insertDelivery.run(id, room, recipient);

    return {
      id,
      room,
      threadId,
      replyTo: input.replyTo ?? null,
      sender,
      kind,
      subject: input.subject ?? null,
      body: input.body,
      createdAt: ts,
      to: recipients,
    };
  }

  /** Recipients that are neither `*` nor a registered agent in the room. */
  unknownRecipients(room: string, to: string[]): string[] {
    const known = new Set(this.roster(room).map((a) => a.name));
    return normalizeRecipients(to).filter((r) => r !== BROADCAST && !known.has(r));
  }

  /**
   * Room-log only: written with no delivery rows, so it shows up in `morse log`
   * and `history` but never in anyone's inbox. Presence churn must not wake a
   * parked agent — an "x joined" broadcast would otherwise interrupt every
   * blocking ask in the room and look exactly like a real answer failing to
   * arrive.
   */
  systemMessage(room: string, body: string): void {
    this.insert({ room, sender: "morse", to: [], body }, [], "system");
  }

  /**
   * Messages addressed to `name` (directly or by broadcast) after its cursor.
   * `advance` moves the cursor past what is returned, which is what makes a
   * message "read".
   */
  inbox(room: string, name: string, opts: { advance?: boolean; limit?: number } = {}): Message[] {
    const agent = this.getAgent(room, name);
    if (!agent) return [];
    const limit = opts.limit ?? 50;

    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.room = ? AND m.id > ? AND m.sender != ?
           AND EXISTS (SELECT 1 FROM deliveries d
                       WHERE d.message_id = m.id AND (d.recipient = ? OR d.recipient = '*'))
         ORDER BY m.id LIMIT ?`,
      )
      .all(room, agent.cursor, name, name, limit) as Row[];

    const messages = rows.map((r) => this.hydrate(r));
    if (opts.advance !== false && messages.length > 0) {
      const last = messages[messages.length - 1]!.id;
      this.db
        .prepare(`UPDATE agents SET cursor = ? WHERE room = ? AND name = ? AND cursor < ?`)
        .run(last, room, name, last);
    }
    return messages;
  }

  unreadCount(room: string, name: string): number {
    const agent = this.getAgent(room, name);
    if (!agent) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         WHERE m.room = ? AND m.id > ? AND m.sender != ?
           AND EXISTS (SELECT 1 FROM deliveries d
                       WHERE d.message_id = m.id AND (d.recipient = ? OR d.recipient = '*'))`,
      )
      .get(room, agent.cursor, name, name) as Row;
    return Number(row.n);
  }

  thread(room: string, threadId: string, limit = 200): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE room = ? AND thread_id = ? ORDER BY id LIMIT ?`)
      .all(room, threadId, limit) as Row[];
    return rows.map((r) => this.hydrate(r));
  }

  /** Everything in the room, newest-last. Used by `morse log` and `morse_history`. */
  history(room: string, opts: { limit?: number; sinceId?: number } = {}): Message[] {
    const limit = opts.limit ?? 100;
    if (opts.sinceId !== undefined) {
      const rows = this.db
        .prepare(`SELECT * FROM messages WHERE room = ? AND id > ? ORDER BY id LIMIT ?`)
        .all(room, opts.sinceId, limit) as Row[];
      return rows.map((r) => this.hydrate(r));
    }
    const rows = this.db
      .prepare(`SELECT * FROM (SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
      .all(room, limit) as Row[];
    return rows.map((r) => this.hydrate(r));
  }

  /** First message on `threadId` after `afterId` that did not come from `name`. */
  findReply(room: string, threadId: string, afterId: number, name: string): Message | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE room = ? AND thread_id = ? AND id > ? AND sender != ?
         ORDER BY id LIMIT 1`,
      )
      .get(room, threadId, afterId, name) as Row | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * Id of the last thing `sender` said on `threadId`, or 0. Waiting for a reply
   * means waiting for a peer message newer than this — anchoring on the whole
   * thread's high-water mark would skip a reply that landed before we parked.
   */
  lastOwnMessageId(room: string, threadId: string, sender: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(id), 0) AS id FROM messages
         WHERE room = ? AND thread_id = ? AND sender = ?`,
      )
      .get(room, threadId, sender) as Row;
    return Number(row.id);
  }

  /** Who spoke last on the thread, ignoring `exclude`. Used to target replies. */
  lastSpeaker(room: string, threadId: string, exclude: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT sender FROM messages
         WHERE room = ? AND thread_id = ? AND sender != ? ORDER BY id DESC LIMIT 1`,
      )
      .get(room, threadId, exclude) as Row | undefined;
    return row ? String(row.sender) : undefined;
  }

  maxMessageId(room: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room = ?`).get(room) as Row;
    return Number(row.id);
  }

  clearRoom(room: string): void {
    this.db.prepare(`DELETE FROM deliveries WHERE room = ?`).run(room);
    this.db.prepare(`DELETE FROM messages WHERE room = ?`).run(room);
    this.db.prepare(`DELETE FROM agents WHERE room = ?`).run(room);
    this.db.prepare(`DELETE FROM rooms WHERE name = ?`).run(room);
  }

  private hydrate(row: Row): Message {
    const id = Number(row.id);
    const recipients = this.db
      .prepare(`SELECT recipient FROM deliveries WHERE message_id = ? ORDER BY recipient`)
      .all(id) as Row[];
    return {
      id,
      room: String(row.room),
      threadId: String(row.thread_id),
      replyTo: row.reply_to === null ? null : Number(row.reply_to),
      sender: String(row.sender),
      kind: String(row.kind) as MessageKind,
      subject: (row.subject as string | null) ?? null,
      body: String(row.body),
      createdAt: Number(row.created_at),
      to: recipients.map((r) => String(r.recipient)),
    };
  }
}

function toAgent(row: Row): Agent {
  const lastSeen = Number(row.last_seen);
  const status = String(row.status) as AgentStatus;
  // `present` is cleared on a clean exit; last_seen catches the ones that died
  // without getting the chance to say so.
  const present = row.present === undefined || Number(row.present) === 1;
  return {
    room: String(row.room),
    name: String(row.name),
    role: (row.role as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    skills: parseSkills(row.skills),
    status,
    statusNote: (row.status_note as string | null) ?? null,
    harness: (row.harness as string | null) ?? null,
    pid: row.pid === null ? null : Number(row.pid),
    cwd: (row.cwd as string | null) ?? null,
    cursor: Number(row.cursor),
    joinedAt: Number(row.joined_at),
    lastSeen,
    online: present && status !== "offline" && now() - lastSeen < ONLINE_WINDOW_MS,
    alive: present && isRunning(row.pid === null ? null : Number(row.pid)),
  };
}

/**
 * Distinguishes a session that is up but not listening from one that is gone.
 *
 * A harness only acts on its turn, so an agent that has been launched but not
 * yet prompted registers once and then goes quiet. Judged on heartbeat alone it
 * looks identical to a crashed process — but its inbox is still filling up, and
 * a teammate needs to know the difference between "nobody is there" and "they
 * just have not looked yet". The store is machine-wide, so the pid is local.
 */
function isRunning(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseSkills(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function normalizeRecipients(to: string[]): string[] {
  const cleaned = to.map((t) => t.trim()).filter(Boolean);
  if (cleaned.some((t) => t === BROADCAST || t.toLowerCase() === "all" || t.toLowerCase() === "everyone")) {
    return [BROADCAST];
  }
  return [...new Set(cleaned)];
}

let threadCounter = 0;
export function newThreadId(): string {
  threadCounter = (threadCounter + 1) % 0xffff;
  return `t-${now().toString(36)}-${process.pid.toString(36)}-${threadCounter.toString(36)}`;
}
