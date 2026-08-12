import { BROADCAST, normalizeRecipients, type Bus, type Message } from "./bus.js";

/**
 * The bus's contribution to morse's MCP surface: everything that is purely
 * about moving a message.
 *
 * `morse_ask` and `morse_wait` are deliberately *not* here even though they are
 * message operations. Both answer with directory state — the roster, when an
 * ask names nobody who exists; every agent's status, when a wait comes back
 * empty — and the four-method view of a registry cannot supply that. Widening
 * the port to make them fit would trade the whole point of the split for two
 * tools. They are composed in morse-ai instead, alongside `morse_register`,
 * which blends the two halves for the same reason.
 *
 * The tool shapes are declared structurally rather than imported, so this
 * package still depends on nothing.
 */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolSession {
  room: string;
  /** The calling agent's identity, already resolved. */
  me: string;
}

const str = (description: string) => ({ type: "string", description });
const strArray = (description: string) => ({ type: "array", items: { type: "string" }, description });

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Tool descriptions are the protocol documentation the model actually reads, so
 * they say when to reach for each one, not just what it does.
 */
export const BUS_TOOLS: ToolDefinition[] = [
  {
    name: "morse_send",
    title: "Send a message",
    description:
      "Send a message without blocking. Use for handoffs, findings, and status you do not need an answer to. Set `to` to one or more agent names, or ['*'] to broadcast to the whole room. If you need an answer before you can continue, use morse_ask instead.",
    inputSchema: schema(
      {
        to: strArray("Recipient agent names, or ['*'] to broadcast."),
        body: str("The message. Be specific and self-contained; the recipient does not share your context."),
        subject: str("Optional one-line summary."),
        thread_id: str("Continue an existing thread. Omit to start a new one."),
        reply_to: { type: "number", description: "Message id this responds to." },
      },
      ["to", "body"],
    ),
  },
  {
    name: "morse_reply",
    title: "Reply on a thread",
    description:
      "Answer a message on its thread. This addresses the person who spoke last on that thread, so it is the correct way to respond to a morse_ask that is blocking a teammate. Answer the question that was asked; if you cannot, say so explicitly rather than staying silent.",
    inputSchema: schema(
      {
        thread_id: str("The thread to reply on."),
        body: str("Your answer."),
        to: strArray("Override the recipients. Defaults to whoever spoke last on the thread."),
      },
      ["thread_id", "body"],
    ),
  },
  {
    name: "morse_inbox",
    title: "Check messages without waiting",
    description:
      "Return any unread messages immediately and do not block. Use this to check in mid-task; use morse_wait when you have nothing else to do.",
    inputSchema: schema({}),
  },
  {
    name: "morse_thread",
    title: "Read a thread",
    description:
      "Read the full history of one thread. Use it to recover context you have lost, or to catch up on a conversation you were added to partway through.",
    inputSchema: schema({ thread_id: str("The thread to read.") }, ["thread_id"]),
  },
  {
    name: "morse_history",
    title: "Read the room log",
    description:
      "Read recent traffic in the room, including messages not addressed to you. Use it to catch up after joining late or to see what the group has already settled.",
    inputSchema: schema({ limit: { type: "number", description: "How many messages. Default 40." } }),
  },
];

/** Returns `undefined` for a tool this package does not own. */
export function busHandler(bus: Bus) {
  return async (
    tool: string,
    args: Record<string, unknown>,
    session: ToolSession,
  ): Promise<unknown | undefined> => {
    const { room, me } = session;

    switch (tool) {
      case "morse_send": {
        const to = normalizeRecipients(toStringArray(args.to));
        const body = requireString(args.body, "body");
        const unknown = await bus.unknownRecipients(room, to);
        const message = bus.send({
          room,
          sender: me,
          to,
          body,
          subject: args.subject as string | undefined,
          threadId: args.thread_id as string | undefined,
          replyTo: args.reply_to === undefined ? undefined : Number(args.reply_to),
        });
        // No echo: the model composed this body one tool call ago, and sending
        // it back doubles what the sender pays to say anything. The id and
        // thread are the two things it does not already have.
        return {
          sent: { id: message.id, thread_id: message.threadId, to: message.to },
          ...(unknown.length > 0
            ? {
                warning: `Not in this room: ${unknown.join(", ")}. Check morse_roster for who is actually here.`,
              }
            : {}),
          hint: "morse_send does not wait. Use morse_ask if you need the answer before continuing.",
        };
      }

      case "morse_reply": {
        const threadId = requireString(args.thread_id, "thread_id");
        const body = requireString(args.body, "body");
        const explicit = args.to === undefined ? undefined : normalizeRecipients(toStringArray(args.to));
        const target = explicit ?? [bus.lastSpeaker(room, threadId, me) ?? BROADCAST];
        if (bus.thread(room, threadId, 1).length === 0) {
          return { error: `No thread '${threadId}' in room '${room}'.` };
        }
        const message = bus.send({
          room,
          sender: me,
          to: target,
          body,
          kind: "reply",
          threadId,
          subject: args.subject as string | undefined,
        });
        return { sent: { id: message.id, thread_id: message.threadId, to: message.to } };
      }

      case "morse_inbox": {
        const messages = bus.inbox(room, me);
        return { messages: messages.map((m) => renderMessage(m, me)), count: messages.length };
      }

      case "morse_thread": {
        const threadId = requireString(args.thread_id, "thread_id");
        return { thread_id: threadId, messages: bus.thread(room, threadId).map((m) => renderMessage(m)) };
      }

      case "morse_history": {
        const limit = args.limit === undefined ? 40 : Math.max(1, Math.min(500, Number(args.limit)));
        return { room, messages: bus.history(room, { limit }).map((m) => renderMessage(m)) };
      }

      default:
        return undefined;
    }
  };
}

/**
 * `viewer` trims envelope the reader can infer: `to` disappears when the reader
 * is the sole recipient (mail in your own inbox is addressed to you), and a
 * null subject disappears rather than shipping as an explicit null. Pass no
 * viewer for room-wide feeds — in `thread` and `history`, who a message was
 * addressed to is information.
 */
export function renderMessage(message: Message, viewer?: string): Record<string, unknown> {
  const toSelfOnly = viewer !== undefined && message.to.length === 1 && message.to[0] === viewer;
  return {
    id: message.id,
    thread_id: message.threadId,
    from: message.sender,
    ...(toSelfOnly ? {} : { to: message.to }),
    kind: message.kind,
    ...(message.subject === null ? {} : { subject: message.subject }),
    body: message.body,
    at: new Date(message.createdAt).toISOString(),
  };
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`\`${field}\` is required.`);
  return value;
}

export function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  throw new Error("`to` must be an agent name or an array of names.");
}

export function hintForAsk(outcome: string, threadId: string): string {
  switch (outcome) {
    case "replied":
      return "Answer received. Continue your work, or morse_reply on the thread to follow up.";
    case "interrupted":
      return `Other mail arrived first, so your question is still unanswered. Deal with that mail, then call morse_wait with thread_id '${threadId}' to keep waiting.`;
    default:
      return `No answer yet. They may be busy. Call morse_wait with thread_id '${threadId}' to keep waiting, or proceed on a stated assumption and tell them what you assumed.`;
  }
}
