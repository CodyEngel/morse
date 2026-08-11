import { Bus, type Message, type SendInput } from "@morse-ai/bus";
import { FileRegistry, type Agent, type AgentStatus } from "@morse-ai/registry";

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

type Row = Record<string, unknown>;

/**
 * Where the two halves meet.
 *
 * `@morse-ai/bus` and `@morse-ai/registry` do not know about each other — the
 * bus talks to a four-method interface, and the registry happens to satisfy it.
 * Composing them is this package's job, and so is everything that genuinely
 * needs both: registering (publish a capability *and* open a mailbox), the
 * roster with unread counts, and the one-time import of records written by
 * morse 0.2.
 */
export class Morse {
  readonly bus: Bus;
  readonly registry: FileRegistry;
  /** Rooms whose legacy rows have been checked this process. */
  private readonly imported = new Set<string>();

  constructor(options: { bus?: Bus; registry?: FileRegistry } = {}) {
    this.registry = options.registry ?? new FileRegistry();
    this.bus = options.bus ?? new Bus({ registry: this.registry });
  }

  // --------------------------------------------------------------- agents

  /**
   * Publish who this agent is, and give it a mailbox.
   *
   * Both halves, which is why it lives here. The registry decides what the
   * agent *is*; the bus decides whether this is a first arrival worth
   * announcing, by asking whether it already has somewhere to receive mail.
   */
  register(input: RegisterInput): Agent {
    this.importLegacy(input.room);
    const name = input.name.trim().toLowerCase();
    const { agent } = this.registry.publish({ ...input, name });
    this.bus.join(input.room, name);
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

  /** The roster as a human wants it: who is here, and what is waiting for them. */
  rosterWithUnread(room: string): (Agent & { unread: number })[] {
    return this.roster(room).map((agent) => ({
      ...agent,
      unread: this.bus.unreadCount(room, agent.name),
    }));
  }

  touch(room: string, name: string): void {
    this.registry.heartbeat(room, name);
  }

  setStatus(room: string, name: string, status: AgentStatus, note?: string | null): void {
    this.registry.setStatus(room, name, status, note);
  }

  leave(room: string, name: string, announce = true): void {
    this.registry.depart(room, name);
    if (announce) this.bus.systemMessage(room, `${name} left the room.`);
  }

  // ---------------------------------------------------------------- rooms

  /**
   * Every room morse knows about, from both halves.
   *
   * A room whose agents have all been forgotten still has a log worth finding,
   * and a room somebody joined but never spoke in is still a room.
   */
  listRooms(): { name: string; topic: string | null; agents: number; messages: number }[] {
    const agents = new Map<string, number>();
    for (const room of this.registry.listRooms()) agents.set(room.name, room.agents);

    const messages = new Map<string, number>();
    for (const room of this.bus.rooms()) {
      messages.set(room.name, room.messages);
      if (!agents.has(room.name)) agents.set(room.name, this.registry.list(room.name).length);
    }

    return [...agents.keys()].sort().map((name) => ({
      name,
      // Never populated in any released version; kept so the shape does not change.
      topic: null,
      agents: agents.get(name) ?? 0,
      messages: messages.get(name) ?? 0,
    }));
  }

  clearRoom(room: string): void {
    this.bus.clearRoom(room);
    // Legacy rows for this room go too. Dropping the table is off limits, but
    // `morse reset` means the room is gone — leaving 0.2 rows behind would
    // resurrect the roster on the next read, which is not what "cleared" means.
    try {
      this.bus.database.prepare(`DELETE FROM agents WHERE room = ?`).run(room);
    } catch {
      // No legacy table, which is the normal case from 0.3.0 on.
    }
    this.registry.forgetRoom(room);
    this.imported.delete(room);
  }

  // -------------------------------------------------------------- messages
  //
  // Thin pass-throughs. They exist so callers that need both halves are not
  // forced to reach into `.bus` for half their work.

  send(input: SendInput): Message {
    return this.bus.send(input);
  }

  async unknownRecipients(room: string, to: string[]): Promise<string[]> {
    this.importLegacy(room);
    return this.bus.unknownRecipients(room, to);
  }

  inbox(room: string, name: string, opts?: { advance?: boolean; limit?: number }): Message[] {
    this.importLegacy(room);
    return this.bus.inbox(room, name, opts);
  }

  unreadCount(room: string, name: string): number {
    this.importLegacy(room);
    return this.bus.unreadCount(room, name);
  }

  thread(room: string, threadId: string, limit?: number): Message[] {
    return this.bus.thread(room, threadId, limit);
  }

  history(room: string, opts?: { limit?: number; sinceId?: number }): Message[] {
    return this.bus.history(room, opts);
  }

  findReply(room: string, threadId: string, afterId: number, name: string): Message | undefined {
    return this.bus.findReply(room, threadId, afterId, name);
  }

  lastOwnMessageId(room: string, threadId: string, sender: string): number {
    return this.bus.lastOwnMessageId(room, threadId, sender);
  }

  lastSpeaker(room: string, threadId: string, exclude: string): string | undefined {
    return this.bus.lastSpeaker(room, threadId, exclude);
  }

  maxMessageId(room: string): number {
    return this.bus.maxMessageId(room);
  }

  systemMessage(room: string, body: string): void {
    this.bus.systemMessage(room, body);
  }

  // ------------------------------------------------------------ migration

  /**
   * Move agent rows written by a pre-0.3 morse into files, once per room.
   *
   * This lives here rather than in either package because it needs both: the
   * legacy rows are SQL, which the registry must never touch, and writing a
   * record is `publish`, which is not part of the bus's four-method view of a
   * registry.
   *
   * Triggered from read paths as well as writes. Hanging it off `register`
   * alone passes a roster test and still loses mail — `inbox` and
   * `unreadCount` would report an empty mailbox against a cursor that was
   * seven messages behind.
   */
  private importLegacy(room: string): void {
    if (this.imported.has(room)) return;
    this.imported.add(room);
    if (this.registry.list(room).length > 0) return;

    let rows: Row[];
    try {
      rows = this.bus.database.prepare(`SELECT * FROM agents WHERE room = ?`).all(room) as Row[];
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
        this.bus.setCursor(room, name, Number(row.cursor ?? 0));
        this.registry.setStatus(
          room,
          name,
          String(row.status ?? "idle") as AgentStatus,
          (row.status_note as string | null) ?? null,
        );
        if (Number(row.present ?? 1) === 0) this.registry.depart(room, name);
      } catch {
        // One unnameable legacy row must not block the rest of the room.
      }
    }
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
