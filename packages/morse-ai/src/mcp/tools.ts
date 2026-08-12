import type { ToolDefinition } from "@morse-ai/bus";

/**
 * The tools morse-ai owns, because each one needs both halves at once.
 *
 * `morse_register` publishes a capability to the registry *and* opens a mailbox
 * on the bus. `morse_ask` and `morse_wait` move messages *and* answer with
 * directory state — the roster when an ask names nobody who exists, every
 * agent's status when a wait comes back empty. Neither sub-package could own
 * them without depending on the other.
 *
 * The other seven live with the package that implements them: see
 * `REGISTRY_TOOLS` and `BUS_TOOLS`.
 */
const str = (description: string) => ({ type: "string", description });
const strArray = (description: string) => ({ type: "array", items: { type: "string" }, description });

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export const COMPOSED_TOOLS: ToolDefinition[] = [
  {
    name: "morse_register",
    title: "Join the room",
    description:
      "Announce yourself to the room and publish what you are good at. Call this once at the start of your session, and again whenever your expertise or focus changes. Your description is what teammates read when deciding who to ask, so make it concrete about what you own and what you do NOT own. Returns the roster and any messages already waiting for you — handle those before anything else.",
    inputSchema: schema({
      name: str("Your agent name, e.g. 'backend'. Defaults to $MORSE_AGENT."),
      role: str("Human-readable role, e.g. 'Backend Engineer'."),
      description: str("What you own and what you should be asked about (1-3 sentences)."),
      skills: strArray("Short capability tags, e.g. ['sql','api-design','performance']."),
    }),
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
          description: "How long to wait for the answer. Omit to use the session default.",
        },
      },
      ["to", "body"],
    ),
  },
  {
    name: "morse_wait",
    title: "Wait for messages",
    description:
      "Block until mail arrives for you, then return it. This is how you hear anything while idle — nothing can interrupt you between turns, so you must park here on purpose. Call it whenever you have finished your current work and are waiting on teammates. Mail interrupts the park immediately, so a long timeout costs nothing in responsiveness — pass a long timeout_seconds when you expect to be idle. If it returns no messages and you have nothing outstanding, park again.",
    inputSchema: schema({
      timeout_seconds: {
        type: "number",
        description: "How long to park. Omit for the session default; go long (600+) when idle.",
      },
      thread_id: str("Only return messages on this thread. Use to resume an interrupted morse_ask."),
    }),
  },
];
