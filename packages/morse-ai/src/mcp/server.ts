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
import { REGISTRY_TOOLS, registryHandler, renderAgentBrief, resolveRoom, type Agent } from "@morse-ai/registry";
import { Morse } from "../morse.js";
import { VERSION } from "../version.js";
import { serve } from "./rpc.js";
import { COMPOSED_TOOLS } from "./tools.js";
import { encodeToon } from "../toon.js";

const DEFAULT_WAIT_SECONDS = positiveOr(Number(process.env.MORSE_WAIT_SECONDS), 50);
const MAX_WAIT_SECONDS = positiveOr(Number(process.env.MORSE_WAIT_MAX), 900);

/**
 * One MCP server, assembled from three contributors.
 *
 * The registry and the bus each own the tools that are purely theirs and hand
 * over a `{ tools, handle }` pair. What is left here are the three that
 * genuinely need both halves — register publishes a capability *and* opens a
 * mailbox; ask and wait move messages *and* answer with directory state — plus
 * everything that needs a *session*: this process lives exactly as long as one
 * agent's harness, so it is the one place that can remember what this agent
 * has already been shown. That memory is what pays for 0.4.0's protocol diet:
 * roster changes ride the next result as a delta instead of a re-fetch, and a
 * coaching hint is said once instead of on every exchange.
 */
export function runMcpServer(): void {
  const store = new Morse();
  const room = resolveRoom();
  let identity = process.env.MORSE_AGENT?.trim() || "";

  // ------------------------------------------------------- session memory
  //
  // All of it is advisory: losing it (a server restart) costs a re-shown
  // roster and a repeated hint, never a message.

  /** Capability hash per teammate (role, description, skills), as last shown. */
  const shownCapabilities = new Map<string, string>();
  /** Status hash per teammate (status, note), as last shown. */
  const shownStatus = new Map<string, string>();
  /** Presence per teammate, as last shown — a true→false flip is a departure. */
  const shownPresent = new Map<string, boolean>();
  /** Coaching said already. Keyed by tool (and outcome, where one exists). */
  const saidHints = new Set<string>();
  /**
   * Whether this session has ever been given work: mail delivered, a reply
   * received, or the agent itself sending/asking/working. Until then, "you can
   * stop" advice is a trap — a first arrival parked ahead of instructions
   * would take it.
   */
  let hadWork = false;

  const fromRegistry = registryHandler(store.registry);
  const fromBus = busHandler(store.bus);

  const tools: ToolDefinition[] = [...COMPOSED_TOOLS, ...REGISTRY_TOOLS, ...BUS_TOOLS];

  // Publish presence at startup rather than on first tool call, so the roster is
  // accurate the moment the harness launches the server.
  if (identity) registerSelf(store, room, identity);

  /**
   * Diff the live roster against what this session was last shown, and
   * remember the new state. `arrived` carries full capabilities because its
   * whole point is routing to someone you have never seen without spending a
   * turn on morse_roster; `departed` is names because there is nothing left to
   * route to. Status is diffed separately from capabilities: "backend went
   * done" arrives the same way "qe joined" does — which is what lets an empty
   * wait drop the room_status block it used to repeat every cycle — but as a
   * slim `{name, status}` entry, because ask/reply traffic flips statuses
   * constantly and re-sending a whole capability blurb per flip would give the
   * churn back.
   */
  function rosterDelta(): Record<string, unknown> {
    const arrived: Record<string, unknown>[] = [];
    const changed: Record<string, unknown>[] = [];
    const departed: string[] = [];
    const current = new Set<string>();

    for (const agent of store.roster(room)) {
      if (agent.name === identity) continue;
      current.add(agent.name);
      const capabilities = JSON.stringify([agent.role, agent.description, agent.skills]);
      const status = JSON.stringify([agent.status, agent.statusNote]);
      const wasPresent = shownPresent.get(agent.name);
      if (!agent.present) {
        if (wasPresent === true) departed.push(agent.name);
      } else if (!shownCapabilities.has(agent.name)) {
        arrived.push(renderAgentBrief(agent));
      } else if (shownCapabilities.get(agent.name) !== capabilities) {
        changed.push(renderAgentBrief(agent));
      } else if (shownStatus.get(agent.name) !== status) {
        changed.push({
          name: agent.name,
          status: agent.status,
          ...(agent.statusNote === null ? {} : { note: agent.statusNote }),
        });
      }
      shownCapabilities.set(agent.name, capabilities);
      shownStatus.set(agent.name, status);
      shownPresent.set(agent.name, agent.present);
    }

    // A record that vanished outright (morse reset) is a departure too.
    for (const name of [...shownPresent.keys()]) {
      if (current.has(name)) continue;
      if (shownPresent.get(name)) departed.push(name);
      shownCapabilities.delete(name);
      shownStatus.delete(name);
      shownPresent.delete(name);
    }

    return {
      ...(arrived.length ? { arrived } : {}),
      ...(changed.length ? { changed } : {}),
      ...(departed.length ? { departed } : {}),
    };
  }

  /**
   * Say a hint the first time the situation comes up, then stop. The two
   * outcomes that carry a thread-specific instruction — interrupted, timeout —
   * are exempt: their hints are recovery steps with a thread id in them, not
   * coaching.
   */
  function gateHint(tool: string, result: Record<string, unknown>): Record<string, unknown> {
    if (typeof result.hint !== "string") return result;
    const outcome = typeof result.outcome === "string" ? result.outcome : "";
    if (outcome === "interrupted" || outcome === "timeout") return result;
    const key = `${tool}:${outcome}`;
    if (!saidHints.has(key)) {
      saidHints.add(key);
      return result;
    }
    const { hint: _dropped, ...rest } = result;
    return rest;
  }

  /**
   * Every result passes through here on its way out. A result that already
   * carries the full roster resets the session's memory of it; anything else
   * gets the delta appended — which is almost always nothing, and exactly the
   * newcomer's capabilities when it matters.
   */
  function shape(tool: string, args: Record<string, unknown>, raw: unknown): unknown {
    if (typeof raw !== "object" || raw === null) return raw;
    let result = { ...(raw as Record<string, unknown>) };

    if (tool === "morse_inbox" && Number(result.count) > 0) hadWork = true;

    if (tool === "morse_status") {
      const status = String(args.status ?? "");
      if (status === "working" || status === "blocked") hadWork = true;
    }

    const carriesRoster = tool === "morse_register" || tool === "morse_roster" || "roster" in result;
    if (carriesRoster) {
      rosterDelta(); // Computed for its side effect: this roster is now "shown".
      result = gateHint(tool, result);
    } else {
      result = { ...gateHint(tool, result), ...rosterDelta() };
    }

    // Overrides the gate on purpose: this one is corrective, not coaching.
    if (tool === "morse_status" && !hadWork && typeof result.hint === "string") {
      result.hint =
        "Nobody has sent you work yet. If you are just parking, use morse_wait with a long timeout instead of setting done.";
    }

    return result;
  }

  const format = (process.env.MORSE_FORMAT ?? "toon").trim().toLowerCase();

  serve({
    name: "morse",
    version: VERSION,
    tools,
    // The model surface defaults to TOON — its only reader is a model, and
    // uniform arrays (inboxes, rosters) are where TOON earns its keep. JSON
    // remains one env var away, and is what scripts and tests pin.
    serialize: format === "json" ? undefined : encodeToon,
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
    call: async (tool, args, ctx) => shape(tool, args, await dispatch(tool, args, ctx)),
  });

  async function dispatch(
    tool: string,
    args: Record<string, unknown>,
    ctx: { signal: AbortSignal },
  ): Promise<unknown> {
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
      store.register({
        room,
        name,
        role: (args.role as string | undefined) ?? process.env.MORSE_ROLE,
        description: (args.description as string | undefined) ?? process.env.MORSE_DESCRIPTION,
        skills: (args.skills as string[] | undefined) ?? envSkills(),
        harness: detectHarness(),
        pid: process.pid,
        cwd: process.cwd(),
      });

      // The check-in: one call answers "who am I here with" and "what is
      // already waiting for me", so a session's opening turn is this and then
      // straight to work — or straight to a park.
      const roster = store.roster(room);
      const messages = store.inbox(room, name);
      if (messages.length > 0) hadWork = true;
      const alone = !roster.some((a) => a.name !== name && a.present);

      return {
        you: name,
        room,
        roster: roster.map(renderAgentBrief),
        messages: messages.map((m) => renderMessage(m, name)),
        ...(renamed
          ? {
              notice:
                `Your name is '${assigned}', assigned when this session was launched, so '${requested}' was ignored. ` +
                "Your teammates address you by the assigned name. You may still update your role, description and skills.",
            }
          : {}),
        hint: alone
          ? "You are the first one here, which is normal. Teammates and instructions arrive over morse — park with " +
            "morse_wait (a long timeout_seconds is fine) and stay parked until someone speaks. Do not set status " +
            "done before you have been given work."
          : "Handle anything in messages, then work; park with morse_wait whenever you have nothing left to do.",
      };
    }

    const me = requireIdentity(identity);
    store.touch(room, me);
    const session = { room, me };

    // ------------------------------------------------- composed: ask, wait

    if (tool === "morse_ask") {
      hadWork = true;
      const to = normalizeRecipients(toStringArray(args.to));
      const body = requireString(args.body, "body");
      const unknown = await store.unknownRecipients(room, to);
      if (unknown.length > 0 && unknown.length === to.length) {
        // The roster is the useful half of this error: naming who *is* here
        // is what lets the model recover without another round trip.
        return {
          error: `No agent named ${unknown.join(", ")} in room '${room}'.`,
          roster: store.roster(room).map(renderAgentBrief),
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

      // No `asked` echo: the model wrote that question one tool call ago. The
      // thread id is the one thing it needs back.
      return {
        outcome: result.outcome,
        thread_id: sent.threadId,
        reply: result.reply ? renderMessage(result.reply, me) : undefined,
        inbox: result.inbox.map((m) => renderMessage(m, me)),
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
        if (result.reply || result.inbox.length > 0) hadWork = true;

        return {
          outcome: result.outcome,
          thread_id: threadId,
          reply: result.reply ? renderMessage(result.reply, me) : undefined,
          inbox: result.inbox.map((m) => renderMessage(m, me)),
          hint: hintForAsk(result.outcome, threadId),
        };
      }

      const messages = await waitForInbox(store.bus, room, me, { timeoutMs, signal: ctx.signal });
      if (messages.length === 0) {
        // Empty is the steady state of an idle room, so it has to be nearly
        // free. Roster changes arrive via the delta this result picks up in
        // shape(); the coaching differs by whether work has ever arrived,
        // and either way is said once.
        return {
          messages: [],
          waited_seconds: Math.round(timeoutMs / 1000),
          hint: hadWork
            ? "Nothing arrived. If you still have outstanding work, keep going; if you are waiting on someone, ask " +
              "them directly. If your part is finished and everyone else is done, set morse_status to 'done' and stop."
            : "Nothing yet — you have not been given work, and being early is normal. Park again with morse_wait and " +
              "a long timeout_seconds. Do not set status done or stop.",
        };
      }
      hadWork = true;
      return {
        messages: messages.map((m) => renderMessage(m, me)),
        hint: "Reply on a thread with morse_reply.",
      };
    }

    if (tool === "morse_send" || tool === "morse_reply") hadWork = true;

    // ------------------------------------------------------- contributed

    const contributed =
      (await fromRegistry(tool, args, session)) ?? (await fromBus(tool, args, session));
    if (contributed !== undefined) return contributed;

    throw new Error(`Unknown tool: ${tool}`);
  }
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

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function waitMs(value: unknown): number {
  const seconds = value === undefined ? DEFAULT_WAIT_SECONDS : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return Math.min(DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS) * 1000;
  }
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
