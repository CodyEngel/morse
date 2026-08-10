import type { DatabaseSync } from "node:sqlite";
import { FileRegistry, type Agent, type AgentStatus } from "@morse-ai/registry";
import { openDb, now } from "./db.js";

export type MessageKind = "message" | "ask" | "reply" | "broadcast" | "system";

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

/**
 * The message log, plus just enough of the registry to keep the existing API.
 *
 * Agent records live in files and are owned by `@morse-ai/registry`; only the
 * read cursor stays here, because it is a property of a mailbox rather than of
 * an identity. See docs/plans/multi-package-split.md.
 */
export class Store {
  private readonly registry: FileRegistry;
  /** Rooms whose legacy rows have been checked this process. */
  private readonly imported = new Set<string>();

  constructor(
    private readonly db: DatabaseSync = openDb(),
    registry: FileRegistry = new FileRegistry(),
  ) {
    this.registry = registry;
  }

  // ---------------------------------------------------------------- rooms

  /**
   * Every room morse knows about: ones with agents, and ones with only traffic.
   *
   * Both halves are needed. A room whose agents have all been forgotten still
   * has a log worth finding, and a room somebody joined but never spoke in is
   * still a room.
   */
  listRooms(): { name: string; topic: string | null; agents: number; messages: number }[] {
    const counts = new Map<string, number>();
    for (const room of this.registry.listRooms()) counts.set(room.name, room.agents);

    const rows = this.db
      .prepare(`SELECT room, COUNT(*) AS messages FROM messages GROUP BY room`)
      .all() as Row[];
    const messages = new Map<string, number>();
    for (const row of rows) {
      const name = String(row.room);
      messages.set(name, Number(row.messages));
      if (!counts.has(name)) counts.set(name, this.registry.list(name).length);
    }

    return [...counts.keys()].sort().map((name) => ({
      name,
      // Never populated in any released version; kept so the shape does not change.
      topic: null,
      agents: counts.get(name) ?? 0,
      messages: messages.get(name) ?? 0,
    }));
  }

  // --------------------------------------------------------------- agents

  register(input: RegisterInput): Agent {
    this.importLegacy(input.room);
    const name = input.name.trim().toLowerCase();

    // "First time" is a question about the mailbox, not about the directory:
    // the join announcement marks acquiring an inbox here, and an agent may
    // well have been published by something that never touched this bus.
    const hasMailbox = this.cursorOf(input.room, name) !== undefined;
    const { agent } = this.registry.publish({ ...input, name });

    if (!hasMailbox) {
      // A first-time joiner starts at the current high-water mark rather than
      // being flooded with the room's backlog. `history` is there if it wants it.
      this.setCursor(input.room, name, this.maxMessageId(input.room));
      this.systemMessage(input.room, `${name} joined the room.`);
    }
    return agent;
  }

  getAgent(room: string, name: string): Agent | undefined {
    this.importLegacy(room);
    return this.registry.get(room, name);
  }

  roster(room: string): Agent[] {
    this.importLegacy(room);
    return this.registry.list(room);
  }

  /** Bump last_seen. Called on every tool invocation and every wait poll. */
  touch(room: string, name: string): void {
    this.registry.heartbeat(room, name);
  }

  setStatus(room: string, name: string, status: AgentStatus, note?: string | null): void {
    this.registry.setStatus(room, name, status, note);
  }

  leave(room: string, name: string, announce = true): void {
    this.registry.depart(room, name);
    if (announce) this.systemMessage(room, `${name} left the room.`);
  }

  /**
   * Move agent rows written by a pre-0.3 morse into files, once per room.
   *
   * Triggered from the read paths as well as the write ones on purpose. Hanging
   * it off `register` alone would work for `morse join` and leave `morse roster`
   * and `morse log` showing an empty room against a populated database — which
   * reads exactly like the upgrade ate your history.
   */
  private importLegacy(room: string): void {
    if (this.imported.has(room)) return;
    this.imported.add(room);
    if (this.registry.list(room).length > 0) return;

    let rows: Row[];
    try {
      rows = this.db.prepare(`SELECT * FROM agents WHERE room = ?`).all(room) as Row[];
    } catch {
      return; // No legacy table: a store created by this version or later.
    }
    if (rows.length === 0) return;

    for (const row of rows) {
      const name = String(row.name).trim().toLowerCase();
      try {
        this.registry.publish({
          room,
          name,
          role: (row.role as string | null) ?? undefined,
          description: (row.description as string | null) ?? undefined,
          skills: parseSkills(row.skills),
          harness: (row.harness as string | null) ?? undefined,
          pid: row.pid === null ? undefined : Number(row.pid),
          cwd: (row.cwd as string | null) ?? undefined,
        });
        // Carry the read position across, or the agent is handed the backlog.
        this.setCursor(room, name, Number(row.cursor ?? 0));
        const status = String(row.status ?? "idle") as AgentStatus;
        this.registry.setStatus(room, name, status, (row.status_note as string | null) ?? null);
        if (Number(row.present ?? 1) === 0) this.registry.depart(room, name);
      } catch {
        // One unnameable legacy row must not block the rest of the room.
      }
    }
  }

  // -------------------------------------------------------------- cursors

  /**
   * The import fires here rather than at each call site, because every path
   * that cares about a cursor — `inbox`, `unreadCount`, `register` — goes
   * through it. Wiring it to the roster alone left `morse log` on an upgraded
   * room reporting zero unread against a mailbox that was seven messages
   * behind, which is the quiet half of "the upgrade ate my room".
   */
  private cursorOf(room: string, name: string): number | undefined {
    this.importLegacy(room);
    const row = this.db
      .prepare(`SELECT cursor FROM cursors WHERE room = ? AND name = ?`)
      .get(room, name) as Row | undefined;
    return row === undefined ? undefined : Number(row.cursor);
  }

  private setCursor(room: string, name: string, cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (room, name, cursor) VALUES (?, ?, ?)
         ON CONFLICT(room, name) DO UPDATE SET cursor = excluded.cursor`,
      )
      .run(room, name, cursor);
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
    const cursor = this.cursorOf(room, name);
    if (cursor === undefined) return []; // No mailbox here yet.
    const limit = opts.limit ?? 50;

    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.room = ? AND m.id > ? AND m.sender != ?
           AND EXISTS (SELECT 1 FROM deliveries d
                       WHERE d.message_id = m.id AND (d.recipient = ? OR d.recipient = '*'))
         ORDER BY m.id LIMIT ?`,
      )
      .all(room, cursor, name, name, limit) as Row[];

    const messages = rows.map((r) => this.hydrate(r));
    if (opts.advance !== false && messages.length > 0) {
      const last = messages[messages.length - 1]!.id;
      this.db
        .prepare(`UPDATE cursors SET cursor = ? WHERE room = ? AND name = ? AND cursor < ?`)
        .run(last, room, name, last);
    }
    return messages;
  }

  unreadCount(room: string, name: string): number {
    const cursor = this.cursorOf(room, name);
    if (cursor === undefined) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         WHERE m.room = ? AND m.id > ? AND m.sender != ?
           AND EXISTS (SELECT 1 FROM deliveries d
                       WHERE d.message_id = m.id AND (d.recipient = ? OR d.recipient = '*'))`,
      )
      .get(room, cursor, name, name) as Row;
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
    this.db.prepare(`DELETE FROM cursors WHERE room = ?`).run(room);
    // Legacy rows for this room go too. Dropping the table is off limits, but
    // `morse reset` means the room is gone — leaving 0.2 rows behind would
    // resurrect the roster on the next read, which is not what "cleared" means.
    try {
      this.db.prepare(`DELETE FROM agents WHERE room = ?`).run(room);
    } catch {
      // No legacy table, which is the normal case from 0.3.0 on.
    }
    this.registry.forgetRoom(room);
    this.imported.delete(room);
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
