import type { DatabaseSync } from "node:sqlite";
import { openDb, now } from "./db.js";
import type { Registry, Status } from "./registry.js";

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

export interface BusOptions {
  /**
   * Required, with no default, so that running without a registry is a thing
   * you asked for. Pass `unregistered` to mean it.
   */
  registry: Registry;
  db?: DatabaseSync;
}

type Row = Record<string, unknown>;

/**
 * The message log: rooms, delivery, threads, cursors, and the blocking waits
 * that let a turn-based agent hear anything at all.
 *
 * This is the one part of morse that genuinely needs a database, and not for
 * concurrency — for total order. `inbox` is `id > cursor`, which requires a
 * monotonic id across N independent processes. See
 * docs/plans/multi-package-split.md, Decision 1.
 */
export class Bus {
  private readonly db: DatabaseSync;
  private readonly registry: Registry;

  constructor(options: BusOptions) {
    this.registry = options.registry;
    this.db = options.db ?? openDb();
  }

  // --------------------------------------------------------------- mailbox

  /**
   * Give `name` a mailbox in `room`, and announce it the first time.
   *
   * "First time" is a question about the mailbox rather than about the
   * directory: the announcement marks acquiring an inbox here, and an agent may
   * well be published by something that never touched this bus. Re-joining
   * deliberately leaves the cursor alone, which is what stops a reconnecting
   * agent being handed everything it already read.
   */
  join(room: string, name: string, opts: { announce?: boolean } = {}): { firstTime: boolean } {
    if (this.cursorOf(room, name) !== undefined) return { firstTime: false };

    // A first-time joiner starts at the current high-water mark rather than
    // being flooded with the room's backlog. `history` is there if it wants it.
    this.setCursor(room, name, this.maxMessageId(room));
    if (opts.announce !== false) this.systemMessage(room, `${name} joined the room.`);
    return { firstTime: true };
  }

  cursorOf(room: string, name: string): number | undefined {
    const row = this.db
      .prepare(`SELECT cursor FROM cursors WHERE room = ? AND name = ?`)
      .get(room, name) as Row | undefined;
    return row === undefined ? undefined : Number(row.cursor);
  }

  setCursor(room: string, name: string, cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (room, name, cursor) VALUES (?, ?, ?)
         ON CONFLICT(room, name) DO UPDATE SET cursor = excluded.cursor`,
      )
      .run(room, name, cursor);
  }

  // -------------------------------------------------------------- registry

  /** Heartbeat through to the registry. Called on every poll of a parked wait. */
  async heartbeat(room: string, name: string): Promise<void> {
    await this.registry.heartbeat(room, name);
  }

  async status(room: string, name: string): Promise<Status | undefined> {
    return await this.registry.status(room, name);
  }

  async setStatus(room: string, name: string, status: Status, note?: string | null): Promise<void> {
    await this.registry.setStatus(room, name, status, note);
  }

  /**
   * Recipients that are neither `*` nor a known agent in the room.
   *
   * A registry that knows of nobody has no basis to call anyone unknown, so an
   * empty roster yields no warnings rather than warning about every recipient.
   * That distinction is the difference between a useful hint and noise: under
   * `unregistered` — or in a room nobody has joined yet — the every-recipient
   * version fires on every single send and means nothing.
   */
  async unknownRecipients(room: string, to: string[]): Promise<string[]> {
    const names = await this.registry.names(room);
    if (names.length === 0) return [];
    const known = new Set(names);
    return normalizeRecipients(to).filter((r) => r !== BROADCAST && !known.has(r));
  }

  // -------------------------------------------------------------- messages

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

  /** Rooms this bus has traffic for. Says nothing about who is in them. */
  rooms(): { name: string; messages: number }[] {
    const rows = this.db
      .prepare(`SELECT room, COUNT(*) AS messages FROM messages GROUP BY room ORDER BY room`)
      .all() as Row[];
    return rows.map((row) => ({ name: String(row.room), messages: Number(row.messages) }));
  }

  /** Drops this room's traffic and mailboxes. Agent records are not ours to clear. */
  clearRoom(room: string): void {
    this.db.prepare(`DELETE FROM deliveries WHERE room = ?`).run(room);
    this.db.prepare(`DELETE FROM messages WHERE room = ?`).run(room);
    this.db.prepare(`DELETE FROM cursors WHERE room = ?`).run(room);
  }

  /** Escape hatch for the composition layer, which owns the 0.2 -> 0.3 import. */
  get database(): DatabaseSync {
    return this.db;
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
