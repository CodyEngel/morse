import { renderMessage, waitForInbox, waitForReply } from "@morse-ai/bus";
import type { AgentStatus } from "@morse-ai/registry";
import { renderAgent } from "@morse-ai/registry";
import { Morse } from "../morse.js";
import { formatMessage } from "./format.js";

/**
 * The agent-facing half of the CLI: the same ten operations the MCP server
 * exposes, as shell verbs.
 *
 * This exists so a harness that cannot speak MCP can still take part. The
 * mechanism is identical — an agent parks inside a tool call either way, and a
 * Bash tool call is still a tool call — but a CLI has no per-tool descriptions,
 * so the protocol prompt has to carry more of the weight. See
 * `buildPrompt({ transport: "cli" })`.
 */

export interface AgentArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Who this invocation is acting as.
 *
 * `$MORSE_AGENT` outranks `--as`, exactly as it does over `morse_register`'s
 * `name`. Identity is assigned by whoever launched the agent, not chosen by the
 * model — and a model writing its own shell command is every bit as able to
 * type the wrong name as one filling in a tool argument.
 */
export function whoami(args: AgentArgs): string {
  const assigned = process.env.MORSE_AGENT?.trim();
  const requested = typeof args.flags.as === "string" ? args.flags.as.trim() : "";
  if (assigned && requested && assigned !== requested) {
    console.error(
      `morse: your name is '${assigned}', assigned when this session was launched, so '${requested}' was ignored.`,
    );
  }
  const name = assigned || requested;
  if (!name) {
    console.error("Who are you? Pass --as <name>, or set MORSE_AGENT.");
    process.exitCode = 1;
    return "";
  }
  return name.trim().toLowerCase();
}

function wants(args: AgentArgs, flag: string): boolean {
  return Boolean(args.flags[flag]);
}

function emit(args: AgentArgs, payload: unknown, human: () => void): void {
  if (wants(args, "json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  human();
}

function waitSeconds(args: AgentArgs): number {
  const raw = Number(args.flags.timeout ?? process.env.MORSE_WAIT_SECONDS ?? 50);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 900) : 50;
}

/** Handles the agent verbs. Returns false for a command it does not own. */
export async function runAgentCommand(command: string, args: AgentArgs, room: string): Promise<boolean> {
  switch (command) {
    case "register":
      return register(args, room), true;
    case "leave":
      return leave(args, room), true;
    case "inbox":
      return inbox(args, room), true;
    case "wait":
      return await wait(args, room), true;
    case "reply":
      return reply(args, room), true;
    case "thread":
      return thread(args, room), true;
    case "history":
      return history(args, room), true;
    default:
      return false;
  }
}

function register(args: AgentArgs, room: string): void {
  const me = whoami(args);
  if (!me) return;
  const store = new Morse();
  const skills = typeof args.flags.skills === "string" ? args.flags.skills.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const agent = store.register({
    room,
    name: me,
    role: typeof args.flags.role === "string" ? args.flags.role : process.env.MORSE_ROLE,
    description: typeof args.flags.description === "string" ? args.flags.description : process.env.MORSE_DESCRIPTION,
    skills,
    harness: process.env.MORSE_HARNESS ?? "cli",
    // The harness's pid when we know it, so `alive` keeps meaning "the session
    // exists" rather than "this 40ms process is still running".
    pid: harnessPid(),
    cwd: process.cwd(),
  });
  emit(args, { you: agent.name, room, registered: renderAgent(agent), roster: store.roster(room).map(renderAgent) }, () => {
    console.log(`registered ${agent.name} in ${room}`);
  });
}

function leave(args: AgentArgs, room: string): void {
  const me = whoami(args);
  if (!me) return;
  new Morse().leave(room, me);
  emit(args, { left: me, room }, () => console.log(`${me} left ${room}`));
}

function inbox(args: AgentArgs, room: string): void {
  const me = whoami(args);
  if (!me) return;
  const store = new Morse();
  store.touch(room, me);
  const messages = store.inbox(room, me);
  emit(args, { messages: messages.map(renderMessage), count: messages.length }, () => {
    for (const message of messages) console.log(formatMessage(message), "\n");
    if (messages.length === 0) console.log("(nothing waiting)");
  });
}

/**
 * Park until mail arrives. The CLI equivalent of `morse_wait`, and the reason
 * a shell-only agent can take part at all: it blocks inside one command, which
 * is something every harness already knows how to run and wait for.
 */
async function wait(args: AgentArgs, room: string): Promise<void> {
  const me = whoami(args);
  if (!me) return;
  const store = new Morse();
  const timeoutMs = waitSeconds(args) * 1000;
  const threadId = typeof args.flags.thread === "string" ? args.flags.thread : undefined;

  if (threadId) {
    const previous = store.getAgent(room, me)?.status ?? "idle";
    const afterId = store.lastOwnMessageId(room, threadId, me);
    store.setStatus(room, me, "blocked", `waiting for a reply on ${threadId}`);
    const result = await waitForReply(store.bus, room, me, threadId, afterId, { timeoutMs });
    store.setStatus(room, me, result.outcome === "replied" ? "working" : previous);

    emit(
      args,
      {
        outcome: result.outcome,
        thread_id: threadId,
        reply: result.reply ? renderMessage(result.reply) : undefined,
        inbox: result.inbox.map(renderMessage),
      },
      () => {
        for (const message of result.inbox) console.log(formatMessage(message), "\n");
        if (result.reply) console.log(formatMessage(result.reply));
      },
    );
    process.exitCode = exitFor(result.outcome);
    return;
  }

  const messages = await waitForInbox(store.bus, room, me, { timeoutMs });
  emit(
    args,
    {
      messages: messages.map(renderMessage),
      waited_seconds: Math.round(timeoutMs / 1000),
      room_status: messages.length === 0 ? store.roster(room).map((a) => ({ name: a.name, status: a.status, online: a.online })) : undefined,
    },
    () => {
      for (const message of messages) console.log(formatMessage(message), "\n");
      if (messages.length === 0) console.log("(nothing arrived)");
    },
  );
}

function reply(args: AgentArgs, room: string): void {
  const me = whoami(args);
  if (!me) return;
  const [threadId, ...rest] = args.positional;
  const body = rest.join(" ");
  if (!threadId || !body) {
    console.error("Usage: morse reply <thread-id> <message>");
    process.exitCode = 1;
    return;
  }
  const store = new Morse();
  if (store.thread(room, threadId, 1).length === 0) {
    console.error(`No thread '${threadId}' in room '${room}'.`);
    process.exitCode = 1;
    return;
  }
  const target = store.lastSpeaker(room, threadId, me) ?? "*";
  const message = store.send({ room, sender: me, to: [target], body, kind: "reply", threadId });
  emit(args, { sent: renderMessage(message) }, () => console.log(`replied on ${threadId} → ${target}`));
}

function thread(args: AgentArgs, room: string): void {
  const threadId = args.positional[0];
  if (!threadId) {
    console.error("Usage: morse thread <thread-id>");
    process.exitCode = 1;
    return;
  }
  const messages = new Morse().thread(room, threadId);
  emit(args, { thread_id: threadId, messages: messages.map(renderMessage) }, () => {
    for (const message of messages) console.log(formatMessage(message), "\n");
  });
}

function history(args: AgentArgs, room: string): void {
  const limit = Number(args.flags.n ?? args.flags.lines ?? 40);
  const messages = new Morse().history(room, { limit });
  emit(args, { room, messages: messages.map(renderMessage) }, () => {
    for (const message of messages) console.log(formatMessage(message), "\n");
  });
}

/** `morse status set <state> [--note ...]`, leaving the read form alone. */
export function setStatusCommand(args: AgentArgs, room: string): void {
  const state = String(args.positional[1] ?? "").trim() as AgentStatus;
  if (!["idle", "working", "blocked", "done"].includes(state)) {
    console.error("Usage: morse status set <idle|working|blocked|done> [--note <text>]");
    process.exitCode = 1;
    return;
  }
  const me = whoami(args);
  if (!me) return;
  const store = new Morse();
  const note = typeof args.flags.note === "string" ? args.flags.note : undefined;
  store.setStatus(room, me, state, note);
  const outstanding = store.roster(room).filter((a) => a.name !== me && a.status !== "done" && a.online);
  emit(
    args,
    { status: state, note: note ?? null, still_working: outstanding.map((a) => ({ name: a.name, status: a.status })) },
    () => console.log(`${me} is ${state}${note ? ` — ${note}` : ""}`),
  );
}

/**
 * Exit codes, so a shell loop can branch without parsing.
 *
 * 2 for `interrupted` specifically: that outcome means the question is still
 * unanswered *and* you now own mail that has already been marked read. Folding
 * it in with a plain timeout is how that mail gets dropped.
 */
export function exitFor(outcome: string): number {
  switch (outcome) {
    case "replied":
      return 0;
    case "interrupted":
      return 2;
    default:
      return 1;
  }
}

/**
 * The pid worth recording is the harness's, not this process's.
 *
 * Under MCP the server is long-lived and its own pid answers "is the session
 * still there". A CLI invocation exits in milliseconds, so its pid would make
 * every agent read as crashed the instant it finished. `$MORSE_HARNESS_PID` is
 * set by `morse join`; failing that the parent process is the best guess, and
 * failing that we record nothing rather than something false.
 */
export function harnessPid(): number | undefined {
  const declared = Number(process.env.MORSE_HARNESS_PID);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return process.ppid > 1 ? process.ppid : undefined;
}
