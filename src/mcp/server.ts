import { hostname } from "node:os";
import { resolveRoom } from "../room.js";
import { findPreset } from "../roles.js";
import { BROADCAST, Store, normalizeRecipients, type AgentStatus, type Message } from "../store.js";
import { VERSION } from "../version.js";
import { waitForInbox, waitForReply } from "../wait.js";
import { serve, type ToolContext } from "./rpc.js";
import { TOOLS } from "./tools.js";

const DEFAULT_WAIT_SECONDS = Number(process.env.MORSE_WAIT_SECONDS ?? 50);
const MAX_WAIT_SECONDS = 900;

export function runMcpServer(): void {
  const store = new Store();
  const room = resolveRoom();
  let identity = process.env.MORSE_AGENT?.trim() || "";

  // Publish presence at startup rather than on first tool call, so the roster is
  // accurate the moment the harness launches the server.
  if (identity) registerSelf(store, room, identity);

  serve({
    name: "morse",
    version: VERSION,
    tools: TOOLS,
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
        const name = String(args.name ?? identity ?? "").trim();
        if (!name) {
          throw new Error(
            "No agent name. Pass `name`, or set MORSE_AGENT in the morse MCP server's env (see `morse init`).",
          );
        }
        identity = name;
        const preset = findPreset(name);
        const agent = store.register({
          room,
          name,
          role: (args.role as string | undefined) ?? preset?.role,
          description: (args.description as string | undefined) ?? preset?.description,
          skills: (args.skills as string[] | undefined) ?? preset?.skills,
          harness: detectHarness(),
          pid: process.pid,
          cwd: process.cwd(),
        });
        return {
          you: agent.name,
          room,
          registered: renderAgent(agent),
          roster: store.roster(room).map(renderAgent),
          hint: "Check the roster before asking questions, and call morse_wait when you have nothing to do.",
        };
      }

      const me = requireIdentity(identity);
      store.touch(room, me);

      switch (tool) {
        case "morse_roster": {
          const roster = store.roster(room);
          return {
            room,
            you: me,
            agents: roster.map(renderAgent),
            online: roster.filter((a) => a.online).length,
          };
        }

        case "morse_send": {
          const to = normalizeRecipients(toStringArray(args.to));
          const body = requireString(args.body, "body");
          const unknown = store.unknownRecipients(room, to);
          const message = store.send({
            room,
            sender: me,
            to,
            body,
            subject: args.subject as string | undefined,
            threadId: args.thread_id as string | undefined,
            replyTo: args.reply_to === undefined ? undefined : Number(args.reply_to),
          });
          return {
            sent: renderMessage(message),
            ...(unknown.length > 0
              ? {
                  warning: `Not in this room: ${unknown.join(", ")}. Check morse_roster for who is actually here.`,
                }
              : {}),
            hint: "morse_send does not wait. Use morse_ask if you need the answer before continuing.",
          };
        }

        case "morse_ask": {
          const to = normalizeRecipients(toStringArray(args.to));
          const body = requireString(args.body, "body");
          const unknown = store.unknownRecipients(room, to);
          if (unknown.length > 0 && unknown.length === to.length) {
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

          const result = await waitForReply(store, room, me, sent.threadId, sent.id, {
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

        case "morse_reply": {
          const threadId = requireString(args.thread_id, "thread_id");
          const body = requireString(args.body, "body");
          const explicit = args.to === undefined ? undefined : normalizeRecipients(toStringArray(args.to));
          const target = explicit ?? [store.lastSpeaker(room, threadId, me) ?? BROADCAST];
          const thread = store.thread(room, threadId, 1);
          if (thread.length === 0) {
            return { error: `No thread '${threadId}' in room '${room}'.` };
          }
          const message = store.send({
            room,
            sender: me,
            to: target,
            body,
            kind: "reply",
            threadId,
            subject: args.subject as string | undefined,
          });
          return { sent: renderMessage(message) };
        }

        case "morse_wait": {
          const timeoutMs = waitMs(args.timeout_seconds);
          const threadId = args.thread_id as string | undefined;

          if (threadId) {
            // Resuming an interrupted ask is still being blocked, and the room
            // reads `status` to decide whether it has converged. Leaving this
            // agent as 'idle' would let the others conclude it had finished.
            const previous = store.getAgent(room, me)?.status ?? "idle";
            const afterId = store.lastOwnMessageId(room, threadId, me);
            store.setStatus(room, me, "blocked", `waiting for a reply on ${threadId}`);

            const result = await waitForReply(store, room, me, threadId, afterId, {
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

          const messages = await waitForInbox(store, room, me, { timeoutMs, signal: ctx.signal });
          if (messages.length === 0) {
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

        case "morse_inbox": {
          const messages = store.inbox(room, me);
          return { messages: messages.map(renderMessage), count: messages.length };
        }

        case "morse_status": {
          const status = String(args.status ?? "idle") as AgentStatus;
          if (!["idle", "working", "blocked", "done"].includes(status)) {
            throw new Error(`Unknown status '${status}'. Use idle, working, blocked, or done.`);
          }
          store.setStatus(room, me, status, args.note as string | undefined);
          const roster = store.roster(room);
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

        case "morse_thread": {
          const threadId = requireString(args.thread_id, "thread_id");
          return { thread_id: threadId, messages: store.thread(room, threadId).map(renderMessage) };
        }

        case "morse_history": {
          const limit = args.limit === undefined ? 40 : Math.max(1, Math.min(500, Number(args.limit)));
          return { room, messages: store.history(room, { limit }).map(renderMessage) };
        }

        default:
          throw new Error(`Unknown tool: ${tool}`);
      }
    },
  });
}

function registerSelf(store: Store, room: string, name: string): void {
  const preset = findPreset(name);
  store.register({
    room,
    name,
    role: process.env.MORSE_ROLE ?? preset?.role,
    description: process.env.MORSE_DESCRIPTION ?? preset?.description,
    skills: process.env.MORSE_SKILLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? preset?.skills,
    harness: detectHarness(),
    pid: process.pid,
    cwd: process.cwd(),
  });
}

function requireIdentity(identity: string): string {
  if (!identity) {
    throw new Error(
      "You have not joined the room yet. Call morse_register with a `name` first (or set MORSE_AGENT).",
    );
  }
  return identity;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`\`${field}\` is required.`);
  return value;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  throw new Error("`to` must be an agent name or an array of names.");
}

function waitMs(value: unknown): number {
  const seconds = value === undefined ? DEFAULT_WAIT_SECONDS : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_WAIT_SECONDS * 1000;
  return Math.min(seconds, MAX_WAIT_SECONDS) * 1000;
}

function hintForAsk(outcome: string, threadId: string): string {
  switch (outcome) {
    case "replied":
      return "Answer received. Continue your work, or morse_reply on the thread to follow up.";
    case "interrupted":
      return `Other mail arrived first, so your question is still unanswered. Deal with that mail, then call morse_wait with thread_id '${threadId}' to keep waiting.`;
    default:
      return `No answer yet. They may be busy. Call morse_wait with thread_id '${threadId}' to keep waiting, or proceed on a stated assumption and tell them what you assumed.`;
  }
}

function detectHarness(): string {
  const env = process.env;
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_HOME || env.CODEX_THREAD_ID) return "codex";
  if (env.OPENCODE || env.OPENCODE_SERVER) return "opencode";
  return env.MORSE_HARNESS ?? "unknown";
}

function renderAgent(agent: {
  name: string;
  role: string | null;
  description: string | null;
  skills: string[];
  status: string;
  statusNote: string | null;
  online: boolean;
  alive: boolean;
  lastSeen: number;
  harness: string | null;
}): Record<string, unknown> {
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

function renderMessage(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    thread_id: message.threadId,
    from: message.sender,
    to: message.to,
    kind: message.kind,
    subject: message.subject,
    body: message.body,
    at: new Date(message.createdAt).toISOString(),
  };
}
