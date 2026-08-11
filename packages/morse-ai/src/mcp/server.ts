import {
  BUS_TOOLS,
  busHandler,
  hintForAsk,
  normalizeRecipients,
  renderMessage,
  requireString,
  toStringArray,
  waitForInbox,
  waitForReply,
  type ToolDefinition,
} from "@morse-ai/bus";
import { REGISTRY_TOOLS, registryHandler, renderAgent, resolveRoom } from "@morse-ai/registry";
import { Morse } from "../morse.js";
import { VERSION } from "../version.js";
import { serve } from "./rpc.js";
import { COMPOSED_TOOLS } from "./tools.js";

const DEFAULT_WAIT_SECONDS = Number(process.env.MORSE_WAIT_SECONDS ?? 50);
const MAX_WAIT_SECONDS = 900;

/**
 * One MCP server, assembled from three contributors.
 *
 * The registry and the bus each own the tools that are purely theirs and hand
 * over a `{ tools, handle }` pair. What is left here are the three that
 * genuinely need both halves — register publishes a capability *and* opens a
 * mailbox; ask and wait move messages *and* answer with directory state. An
 * agent needs all ten to follow the protocol, which is why there is one server
 * rather than one per package.
 */
export function runMcpServer(): void {
  const store = new Morse();
  const room = resolveRoom();
  let identity = process.env.MORSE_AGENT?.trim() || "";

  const fromRegistry = registryHandler(store.registry);
  const fromBus = busHandler(store.bus);

  const tools: ToolDefinition[] = [...COMPOSED_TOOLS, ...REGISTRY_TOOLS, ...BUS_TOOLS];

  // Publish presence at startup rather than on first tool call, so the roster is
  // accurate the moment the harness launches the server.
  if (identity) registerSelf(store, room, identity);

  serve({
    name: "morse",
    version: VERSION,
    tools,
    onInitialize: (clientInfo) => {
      // The handshake is the only place the harness reliably names itself.
      // Sniffing env vars misses any harness that does not pass its own
      // environment through to the MCP servers it launches — Codex, for one,
      // which showed up on the roster as "unknown".
      const harness = normalizeHarness(clientInfo.name);
      if (identity && harness) store.register({ room, name: identity, harness });
    },
    onShutdown: () => {
      if (identity) {
        try {
          store.leave(room, identity);
        } catch {
          // Losing the goodbye is survivable; peers time the agent out anyway.
        }
      }
    },
    call: async (tool, args, ctx) => {
      if (tool === "morse_register") {
        // Identity is assigned by whoever launched the agent, not chosen by the
        // model. A session that renames itself here would orphan the identity
        // its teammates are addressing and appear twice in the same process —
        // which is exactly what one harness did, registering as "root".
        const assigned = process.env.MORSE_AGENT?.trim();
        const requested = String(args.name ?? "").trim();
        const name = assigned || requested || identity;
        if (!name) {
          throw new Error(
            "No agent name. Pass `name`, or set MORSE_AGENT in the morse MCP server's env (see `morse init`).",
          );
        }
        const renamed = Boolean(assigned && requested && requested !== assigned);
        identity = name;
        // Whatever the agent says about itself wins; the env carries whatever a
        // role file supplied at launch. The server itself knows no roles.
        const agent = store.register({
          room,
          name,
          role: (args.role as string | undefined) ?? process.env.MORSE_ROLE,
          description: (args.description as string | undefined) ?? process.env.MORSE_DESCRIPTION,
          skills: (args.skills as string[] | undefined) ?? envSkills(),
          harness: detectHarness(),
          pid: process.pid,
          cwd: process.cwd(),
        });
        return {
          you: agent.name,
          room,
          registered: renderAgent(agent),
          roster: store.roster(room).map(renderAgent),
          ...(renamed
            ? {
                notice:
                  `Your name is '${assigned}', assigned when this session was launched, so '${requested}' was ignored. ` +
                  "Your teammates address you by the assigned name. You may still update your role, description and skills.",
              }
            : {}),
          hint: "Check the roster before asking questions, and call morse_wait when you have nothing to do.",
        };
      }

      const me = requireIdentity(identity);
      store.touch(room, me);
      const session = { room, me };

      // ------------------------------------------------- composed: ask, wait

      if (tool === "morse_ask") {
        const to = normalizeRecipients(toStringArray(args.to));
        const body = requireString(args.body, "body");
        const unknown = await store.unknownRecipients(room, to);
        if (unknown.length > 0 && unknown.length === to.length) {
          // The roster is the useful half of this error: naming who *is* here
          // is what lets the model recover without another round trip.
          return {
            error: `No agent named ${unknown.join(", ")} in room '${room}'.`,
            roster: store.roster(room).map(renderAgent),
          };
        }

        const sent = store.send({
          room,
          sender: me,
          to,
          body,
          subject: args.subject as string | undefined,
          kind: "ask",
        });
        store.setStatus(room, me, "blocked", `waiting on ${to.join(", ")}`);

        const result = await waitForReply(store.bus, room, me, sent.threadId, sent.id, {
          timeoutMs: waitMs(args.timeout_seconds),
          signal: ctx.signal,
        });
        store.setStatus(room, me, result.outcome === "replied" ? "working" : "idle");

        return {
          outcome: result.outcome,
          thread_id: sent.threadId,
          asked: renderMessage(sent),
          reply: result.reply ? renderMessage(result.reply) : undefined,
          inbox: result.inbox.map(renderMessage),
          hint: hintForAsk(result.outcome, sent.threadId),
        };
      }

      if (tool === "morse_wait") {
        const timeoutMs = waitMs(args.timeout_seconds);
        const threadId = args.thread_id as string | undefined;

        if (threadId) {
          // Resuming an interrupted ask is still being blocked, and the room
          // reads `status` to decide whether it has converged. Leaving this
          // agent as 'idle' would let the others conclude it had finished.
          const previous = store.getAgent(room, me)?.status ?? "idle";
          const afterId = store.lastOwnMessageId(room, threadId, me);
          store.setStatus(room, me, "blocked", `waiting for a reply on ${threadId}`);

          const result = await waitForReply(store.bus, room, me, threadId, afterId, {
            timeoutMs,
            signal: ctx.signal,
          });
          store.setStatus(room, me, result.outcome === "replied" ? "working" : previous);

          return {
            outcome: result.outcome,
            thread_id: threadId,
            reply: result.reply ? renderMessage(result.reply) : undefined,
            inbox: result.inbox.map(renderMessage),
            hint: hintForAsk(result.outcome, threadId),
          };
        }

        const messages = await waitForInbox(store.bus, room, me, { timeoutMs, signal: ctx.signal });
        if (messages.length === 0) {
          // Coming back empty-handed is exactly when the room's state is worth
          // reporting: it is how an agent tells "nobody needs me" from "nobody
          // is left".
          const roster = store.roster(room);
          return {
            messages: [],
            waited_seconds: Math.round(timeoutMs / 1000),
            room_status: roster.map((a) => ({ name: a.name, status: a.status, online: a.online })),
            hint:
              "Nothing arrived. If you still have outstanding work, keep going. If you are waiting on someone, " +
              "consider asking them directly. If your part is finished and everyone else is done, call " +
              "morse_status with 'done' and stop.",
          };
        }
        return { messages: messages.map(renderMessage), hint: "Reply on a thread with morse_reply." };
      }

      // ------------------------------------------------------- contributed

      const contributed =
        (await fromRegistry(tool, args, session)) ?? (await fromBus(tool, args, session));
      if (contributed !== undefined) return contributed;

      throw new Error(`Unknown tool: ${tool}`);
    },
  });
}

function registerSelf(store: Morse, room: string, name: string): void {
  store.register({
    room,
    name,
    role: process.env.MORSE_ROLE,
    description: process.env.MORSE_DESCRIPTION,
    skills: envSkills(),
    harness: detectHarness(),
    pid: process.pid,
    cwd: process.cwd(),
  });
}

function envSkills(): string[] | undefined {
  const raw = process.env.MORSE_SKILLS;
  if (!raw) return undefined;
  return raw.split(",").map((skill) => skill.trim()).filter(Boolean);
}

function requireIdentity(identity: string): string {
  if (!identity) {
    throw new Error(
      "You have not joined the room yet. Call morse_register with a `name` first (or set MORSE_AGENT).",
    );
  }
  return identity;
}

function waitMs(value: unknown): number {
  const seconds = value === undefined ? DEFAULT_WAIT_SECONDS : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_WAIT_SECONDS * 1000;
  return Math.min(seconds, MAX_WAIT_SECONDS) * 1000;
}

/** Best guess at startup; the handshake corrects it a moment later. */
function detectHarness(): string {
  const env = process.env;
  if (env.MORSE_HARNESS) return env.MORSE_HARNESS;
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return "codex";
  if (env.OPENCODE || env.OPENCODE_SERVER) return "opencode";
  return "unknown";
}

/** Client names vary in casing and spacing between harnesses and releases. */
function normalizeHarness(name: string | undefined): string | undefined {
  const cleaned = name?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!cleaned) return undefined;
  if (cleaned.includes("claude")) return "claude-code";
  if (cleaned.includes("codex")) return "codex";
  if (cleaned.includes("opencode")) return "opencode";
  return cleaned;
}
