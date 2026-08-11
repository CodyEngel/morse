import type { Agent, AgentStatus } from "./registry.js";
import type { FileRegistry } from "./registry.js";

/**
 * The registry's contribution to morse's MCP surface: who is here, and how the
 * work is going.
 *
 * The tool shapes are declared structurally rather than imported from a shared
 * package. TypeScript is structural, so the composer in morse-ai can accept
 * these and the bus's without either package depending on the other or on a
 * common transport.
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

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Tool descriptions are the protocol documentation the model actually reads, so
 * they say when to reach for each one, not just what it does.
 */
export const REGISTRY_TOOLS: ToolDefinition[] = [
  {
    name: "morse_roster",
    title: "Who is here",
    description:
      "List everyone in the room with their expertise, current status, and whether they are online right now. Use this before sending, to pick the right teammate by capability rather than guessing at names.",
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
];

/** Returns `undefined` for a tool this package does not own. */
export function registryHandler(registry: FileRegistry) {
  return async (
    tool: string,
    args: Record<string, unknown>,
    session: ToolSession,
  ): Promise<unknown | undefined> => {
    const { room, me } = session;

    switch (tool) {
      case "morse_roster": {
        const roster = registry.list(room);
        return {
          room,
          you: me,
          agents: roster.map(renderAgent),
          online: roster.filter((a) => a.online).length,
        };
      }

      case "morse_status": {
        const status = String(args.status ?? "idle") as AgentStatus;
        if (!["idle", "working", "blocked", "done"].includes(status)) {
          throw new Error(`Unknown status '${status}'. Use idle, working, blocked, or done.`);
        }
        registry.setStatus(room, me, status, args.note as string | undefined);
        const roster = registry.list(room);
        const outstanding = roster.filter((a) => a.name !== me && a.status !== "done" && a.online);
        return {
          status,
          note: args.note ?? null,
          still_working: outstanding.map((a) => ({ name: a.name, status: a.status, note: a.statusNote })),
          hint:
            outstanding.length === 0
              ? "Everyone online is done. If nothing is addressed to you, you can stop."
              : "Others are still working. Call morse_wait in case they need you.",
        };
      }

      default:
        return undefined;
    }
  };
}

export function renderAgent(agent: Agent): Record<string, unknown> {
  return {
    name: agent.name,
    role: agent.role,
    expertise: agent.description,
    skills: agent.skills,
    status: agent.status,
    note: agent.statusNote,
    online: agent.online,
    // Running but not listening. Mail sent now will be read whenever they next
    // take a turn, so do not treat them as gone.
    ...(agent.online ? {} : { presence: agent.alive ? "running, not listening" : "offline" }),
    last_seen_seconds_ago: Math.round((Date.now() - agent.lastSeen) / 1000),
    harness: agent.harness,
  };
}
