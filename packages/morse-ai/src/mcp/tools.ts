import type { ToolDefinition } from "./rpc.js";

const str = (description: string) => ({ type: "string", description });
const strArray = (description: string) => ({ type: "array", items: { type: "string" }, description });

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Tool descriptions are the protocol documentation the model actually reads, so
 * they say when to reach for each one, not just what it does.
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: "morse_register",
    title: "Join the room",
    description:
      "Announce yourself to the room and publish what you are good at. Call this once at the start of your session, and again whenever your expertise or focus changes. Your description is what teammates read when deciding who to ask, so make it concrete about what you own and what you do NOT own. Returns the current roster.",
    inputSchema: schema({
      name: str("Your agent name, e.g. 'backend'. Defaults to $MORSE_AGENT."),
      role: str("Human-readable role, e.g. 'Backend Engineer'."),
      description: str("What you own and what you should be asked about (1-3 sentences)."),
      skills: strArray("Short capability tags, e.g. ['sql','api-design','performance']."),
    }),
  },
  {
    name: "morse_roster",
    title: "Who is here",
    description:
      "List everyone in the room with their expertise, current status, and whether they are online right now. Use this before sending, to pick the right teammate by capability rather than guessing at names.",
    inputSchema: schema({}),
  },
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
    name: "morse_ask",
    title: "Ask and wait for an answer",
    description:
      "Send a question and block until the recipient answers. Use this when you genuinely cannot proceed without the answer. Returns early if unrelated mail arrives (outcome 'interrupted') so two agents waiting on each other cannot deadlock — handle that mail, then call morse_wait with the same thread_id to resume waiting.",
    inputSchema: schema(
      {
        to: str("The agent to ask. Pick by expertise; check morse_roster if unsure."),
        body: str("Your question, with enough context for them to answer without asking you back."),
        subject: str("Optional one-line summary."),
        timeout_seconds: {
          type: "number",
          description: "How long to wait for the answer. Default 50.",
        },
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
    name: "morse_wait",
    title: "Wait for messages",
    description:
      "Block until mail arrives for you, then return it. This is how you hear anything while idle — nothing can interrupt you between turns, so you must park here on purpose. Call it whenever you have finished your current work and are waiting on teammates. If it returns no messages, either call it again or, if you have nothing outstanding, set your status to 'done'.",
    inputSchema: schema({
      timeout_seconds: { type: "number", description: "How long to park. Default 50." },
      thread_id: str("Only return messages on this thread. Use to resume an interrupted morse_ask."),
    }),
  },
  {
    name: "morse_inbox",
    title: "Check messages without waiting",
    description:
      "Return any unread messages immediately and do not block. Use this to check in mid-task; use morse_wait when you have nothing else to do.",
    inputSchema: schema({}),
  },
  {
    name: "morse_status",
    title: "Publish your status",
    description:
      "Tell the room what you are doing. Set 'working' when you pick something up, 'blocked' when you are waiting on someone (say who in the note), and 'done' when your part is finished. Teammates use this to see whether the group has converged, so keep it current.",
    inputSchema: schema(
      {
        status: {
          type: "string",
          enum: ["idle", "working", "blocked", "done"],
          description: "Your current state.",
        },
        note: str("One line of detail, e.g. 'waiting on backend for the query contract'."),
      },
      ["status"],
    ),
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
