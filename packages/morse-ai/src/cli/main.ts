import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runMcpServer } from "../mcp/server.js";
import { buildPrompt } from "../prompt.js";
import { renderAgent, renderAgentBrief, resolveRoom, sanitizeRoom } from "@morse-ai/registry";
import { pluginsEnabled } from "@morse-ai/registry/discovery";
import {
  collectRoles,
  findRole,
  isValidRoleName,
  listRoles,
  loadRole,
  roleSearchOverrides,
  roleSearchPaths,
  roleSearchReport,
  roleTemplate,
  type RoleRejection,
} from "@morse-ai/registry/discovery";
import { BROADCAST, hintForAsk, normalizeRecipients, renderMessage, waitForReply, type Message } from "@morse-ai/bus";
import { Morse } from "../morse.js";
import { VERSION } from "../version.js";
import { agentColor, bold, cyan, dim, formatMessage, relativeTime, safe, statusBadge, yellow } from "./format.js";
import { exitFor, harnessPid, runAgentCommand, setStatusCommand } from "./agent.js";
import { encodeToon } from "../toon.js";

/**
 * Machine output, if any was asked for. `--toon` is what agents are taught;
 * `--json` is the script contract — same shape it has always had, minus the
 * indentation nobody was reading.
 */
function emitMachine(args: Args, payload: unknown): boolean {
  if (args.flags.toon) {
    console.log(encodeToon(payload));
    return true;
  }
  if (args.flags.json) {
    console.log(JSON.stringify(payload));
    return true;
  }
  return false;
}

const HELP = `morse ${VERSION} — agent-to-agent communication for solo builders

  morse join <agent> [-- <harness args>]  Open a Claude Code session wired into the room
  morse roster                            Who is in the room and what they know
  morse log [-f] [-n <count>]             Read the room's traffic (-f to follow)
  morse send <to> <message>               Send as the human operator ('*' broadcasts)
  morse ask <to> <question>               Send and wait for an answer
  morse status                            One-line summary of the room
  morse rooms                             All rooms on this machine
  morse roles [new <name>]                Role definitions found, and where morse looks
  morse prompt <agent>                    Print the protocol prompt for an agent
  morse init                              Write .mcp.json so plain \`claude\` sees morse
  morse reset [--force]                   Clear the room (asks first)
  morse mcp                               Run the MCP server (harnesses call this)

Agent verbs (also available over MCP; --toon or --json for machine output):
  morse register / leave                  Join or depart, as $MORSE_AGENT or --as
  morse inbox                             Unread mail, without blocking
  morse wait [--thread <id>]              Block until mail arrives
  morse reply <thread> <message>          Answer on a thread
  morse thread <id> / morse history       Re-read a conversation, or the room
  morse status set <state> [--note ...]   Publish what you are doing

Options:
  --room <name>   Override the room (default: this git repo's name)
  --no-plugins    Only read .morse/roles, not other tools' agent folders
  --help          Show this message

The store is machine-wide at ~/.morse/morse.db; rooms keep projects apart.
Morse ships no roles. It reads its own, and borrows agent definitions other
tools already keep — \`morse roles\` shows every directory it looks in and which
plugin supplied each definition.`;

/**
 * Per transport, because the spellings differ: a CLI-transport session has no
 * MCP tools, and telling it to "call morse_register" sends it looking for a
 * tool that does not exist. One call is the whole opening on either transport —
 * register returns the roster and any waiting mail in the same result.
 */
export const OPENING_TURNS = {
  mcp:
    "Join the room: call morse_register — its result includes the roster and anything already waiting for you. " +
    "Deal with what came back, then call morse_wait and stay parked; keep following the protocol in your system " +
    "prompt. Do not stop and hand back to me while teammates are still working, and do not set status done " +
    "before you have been given work.",
  cli:
    "Join the room: run `morse register --toon` — its output includes the roster and anything already waiting " +
    "for you. Deal with what came back, then run `morse wait --toon` and let it block; keep following the " +
    "protocol in your system prompt. Do not stop and hand back to me while teammates are still working, and do " +
    "not set status done before you have been given work.",
} as const;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  passthrough: string[];
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // Version first: `morse --version` has no command, and the help branch below
  // would otherwise swallow it.
  if (args.flags.version || args.command === "version") {
    console.log(VERSION);
    return;
  }
  if (args.flags.help || args.command === "help" || !args.command) {
    console.log(HELP);
    return;
  }

  // Set before any command reads a role. An env var rather than a parameter
  // threaded through every call site, so a joined session's MCP server inherits
  // the same answer the CLI gave — one machine, one view of what is discoverable.
  if (args.flags["no-plugins"]) process.env.MORSE_PLUGINS = "off";

  const room = args.flags.room ? sanitizeRoom(String(args.flags.room)) : resolveRoom();

  // The agent verb set: the same operations the MCP server exposes, as shell
  // commands, for harnesses that cannot speak MCP.
  if (await runAgentCommand(args.command, args, room)) return;

  switch (args.command) {
    case "mcp":
      return runMcpServer();
    case "join":
      return join_(args, room);
    case "roster":
      return roster(args, room);
    case "log":
      return log(args, room);
    case "send":
      return send(args, room);
    case "ask":
      return ask(args, room);
    case "status":
      // `morse status` has meant "one-line summary of the room" since 0.1.0.
      // The write form is a subcommand rather than a flag so that stays true.
      if (args.positional[0] === "set") return setStatusCommand(args, room);
      return status(args, room);
    case "rooms":
      return rooms(args);
    case "roles":
      return roles(args);
    case "prompt":
      return prompt(args, room);
    case "init":
      return init(room);
    case "reset":
      return reset(args, room);
    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

// --------------------------------------------------------------------- join

/**
 * Launch a harness session that is already a member of the room.
 *
 * The MCP server is passed inline with an explicit MORSE_AGENT rather than
 * relying on .mcp.json plus shell inheritance, so six terminals differ only by
 * the argument you type. `morse` is invoked through the current node binary and
 * this script's absolute path, which keeps it working under npx.
 */
async function join_(args: Args, room: string): Promise<void> {
  const name = args.positional[0];
  if (!name) {
    console.error("Usage: morse join <agent>\n");
    const available = listRoles();
    if (available.length) {
      console.error("Roles found:");
      for (const entry of available) console.error(`  ${entry.name.padEnd(16)} ${entry.role ?? ""}`);
    } else {
      console.error("Any name works. `morse roles` shows where role definitions are looked up.");
    }
    process.exitCode = 1;
    return;
  }

  // A role is optional. Without one the agent still joins and coordinates; it
  // just describes itself instead of being handed a description.
  const found = findRole(name);
  const role = found.role;
  // But "no role" and "a role we refused to load" are different situations, and
  // this is the moment the difference matters: the user has named a role and is
  // about to get an agent without one. Silence here is indistinguishable from a
  // typo, and the user cannot debug a directory they did not create.
  reportRejections(found.rejected);
  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));

  // CLI transport: the agent drives morse with shell commands instead of MCP
  // tools, which is the path for any harness `buildHarnessArgs` cannot wire.
  const transport = args.flags.transport === "cli" ? "cli" : "mcp";
  const systemPrompt = buildPrompt({ name, room, role, transport });
  const harness = String(args.flags.harness ?? "claude");
  const headless = args.passthrough.some((arg) => arg === "-p" || arg === "--print" || arg === "exec");

  // The launcher, not the agent, sizes the park: Claude Code's MCP tool
  // timeout is effectively unbounded, so its sessions idle at 270 s — just
  // under the 5-minute prompt-cache TTL, so each re-park turn finds the cache
  // warm. Codex and anything unrecognised keep the conservative 50. An
  // explicit MORSE_WAIT_SECONDS in your environment outranks both.
  const isClaudeCode = harnessKind(harness) === "claude" && /(^|\/)claude$/.test(harness.trim());
  const waitSeconds = process.env.MORSE_WAIT_SECONDS ?? (isClaudeCode ? "270" : "50");

  const serverEnv: Record<string, string> = {
    MORSE_AGENT: name,
    MORSE_ROOM: room,
    MORSE_WAIT_SECONDS: waitSeconds,
    ...(role?.role ? { MORSE_ROLE: role.role } : {}),
    ...(role?.description ? { MORSE_DESCRIPTION: role.description } : {}),
    ...(role?.skills.length ? { MORSE_SKILLS: role.skills.join(",") } : {}),
    ...(process.env.MORSE_DB ? { MORSE_DB: process.env.MORSE_DB } : {}),
    ...(process.env.MORSE_HOME ? { MORSE_HOME: process.env.MORSE_HOME } : {}),
    ...(process.env.MORSE_PLUGINS ? { MORSE_PLUGINS: process.env.MORSE_PLUGINS } : {}),
    ...(process.env.MORSE_WAIT_MAX ? { MORSE_WAIT_MAX: process.env.MORSE_WAIT_MAX } : {}),
    ...(process.env.MORSE_FORMAT ? { MORSE_FORMAT: process.env.MORSE_FORMAT } : {}),
  };

  const harnessArgs = buildHarnessArgs({
    harness,
    transport,
    node: process.execPath,
    cliPath,
    serverEnv,
    systemPrompt,
    passthrough: args.passthrough,
    // Without an opening turn the session registers and then sits at the
    // prompt: present on the roster, accumulating mail, listening to none of
    // it, and indistinguishable from a crash until a human types something.
    opening: headless ? undefined : OPENING_TURNS[transport],
  });

  console.log(
    `${dim("morse:")} joining ${agentColor(name)(bold(name))} to room ${cyan(room)} via ${harness}`,
  );
  // The body of a role file is appended to the agent's system prompt, so a role
  // picked up from a cloned repository is executable instruction. Name the file,
  // and name the tool it was written for — a definition morse borrowed from
  // another ecosystem is the case most likely to surprise someone.
  if (role) {
    const origin = role.plugin ? `${yellow(role.plugin)} ${dim(role.source)}` : dim(role.source);
    console.log(`${dim("morse:")} role from ${origin}`);
  }

  const child = spawn(harness, harnessArgs, {
    stdio: "inherit",
    // The wait default rides along so a CLI-transport agent's `morse wait`
    // (which reads the environment, not the MCP server's) parks the same way.
    env: { ...process.env, MORSE_AGENT: name, MORSE_ROOM: room, MORSE_WAIT_SECONDS: waitSeconds },
  });

  // Liveness should mean "the session exists", not "some 40ms morse process is
  // still running". Under MCP the server's own pid answered that; a CLI-driven
  // agent has no long-lived morse process, so the harness's pid is the honest
  // answer for both.
  if (child.pid) process.env.MORSE_HARNESS_PID = String(child.pid);

  child.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      console.error(`\nCould not find \`${harness}\` on your PATH.`);
      console.error(`Use --harness <command> to point at a different binary.`);
    } else {
      console.error(`\nFailed to start ${harness}: ${error.message}`);
    }
    process.exitCode = 1;
  });

  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      // The agent's MCP server marks it offline on shutdown; nothing to do here
      // beyond mirroring the harness's exit status.
      if (code) process.exitCode = code;
      resolve();
    });
  });
}

interface HarnessInvocation {
  harness: string;
  /** "cli" skips MCP wiring entirely; the agent uses shell commands. */
  transport?: "mcp" | "cli";
  node: string;
  cliPath: string;
  serverEnv: Record<string, string>;
  systemPrompt: string;
  passthrough: string[];
  opening?: string;
}

/**
 * Every harness speaks MCP, but none of them agree on how to be told about a
 * server or how to have instructions injected. The bus is portable; the launch
 * command is not, so the difference is confined to here.
 */
export function buildHarnessArgs(options: HarnessInvocation): string[] {
  const { harness, node, cliPath, serverEnv, systemPrompt, passthrough, opening } = options;
  const kind = harnessKind(harness);

  // Nothing to wire: the agent reaches morse through its shell, so the only
  // thing it needs from us is the protocol and its identity in the environment.
  if (options.transport === "cli") {
    const args = kind === "codex" ? [...passthrough] : ["--append-system-prompt", systemPrompt, ...passthrough];
    const brief = kind === "codex" && opening ? `${systemPrompt}\n\n---\n\n${opening}` : opening;
    if (brief) args.push(brief);
    return args;
  }

  if (kind === "codex") {
    // Codex takes inline TOML config overrides rather than a JSON blob, and has
    // no system-prompt flag at all — so the protocol goes in the opening turn.
    const env = Object.entries(serverEnv)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
    const args = [
      "-c",
      `mcp_servers.morse.command=${JSON.stringify(node)}`,
      "-c",
      `mcp_servers.morse.args=[${JSON.stringify(cliPath)}, "mcp"]`,
      "-c",
      `mcp_servers.morse.env={${env}}`,
      ...passthrough,
    ];
    const brief = opening ? `${systemPrompt}\n\n---\n\n${opening}` : systemPrompt;
    args.push(brief);
    return args;
  }

  // Claude Code, and the default for anything unrecognised.
  const args = [
    "--mcp-config",
    JSON.stringify({ mcpServers: { morse: { command: node, args: [cliPath, "mcp"], env: serverEnv } } }),
    "--append-system-prompt",
    systemPrompt,
    ...passthrough,
  ];
  if (opening) args.push(opening);
  return args;
}

function harnessKind(harness: string): "claude" | "codex" {
  return /(^|\/)codex(-cli)?$/.test(harness.trim()) ? "codex" : "claude";
}

// -------------------------------------------------------------- inspection

function roster(args: Args, room: string): void {
  const store = new Morse();
  const agents = store.roster(room);
  const online = agents.filter((a) => a.online).length;
  // `--toon` is the agent surface, so it mirrors morse_roster's brief shape;
  // `--json` keeps the operator view with unread counts, exactly as before.
  const payload = args.flags.toon
    ? { room, agents: agents.map(renderAgentBrief), online }
    : {
        room,
        agents: agents.map((a) => ({ ...renderAgent(a), unread: store.unreadCount(room, a.name) })),
        online,
      };
  if (emitMachine(args, payload)) return;
  if (agents.length === 0) {
    console.log(`No agents in room ${cyan(room)} yet. Start one with ${bold("morse join <agent>")}.`);
    return;
  }

  console.log(`${bold(`Room ${room}`)} ${dim(`(${agents.filter((a) => a.online).length}/${agents.length} online)`)}\n`);
  for (const agent of agents) {
    const color = agentColor(agent.name);
    const unread = store.unreadCount(room, agent.name);
    const badge = statusBadge(agent);
    const note = agent.statusNote ? dim(` — ${safe(agent.statusNote)}`) : "";
    console.log(`${color(bold(safe(agent.name).padEnd(16)))} ${badge}${note}`);
    if (agent.role) console.log(`  ${dim(safe(agent.role))}`);
    if (agent.description) console.log(`  ${wrapText(safe(agent.description), 76, "  ")}`);
    if (agent.skills.length) console.log(`  ${dim(safe(agent.skills.join(" · ")))}`);
    console.log(
      `  ${dim(`seen ${relativeTime(agent.lastSeen)}`)}${unread ? yellow(` · ${unread} unread`) : ""}\n`,
    );
  }
}

function status(args: Args, room: string): void {
  const store = new Morse();
  const agents = store.roster(room);
  const online = agents.filter((a) => a.online);
  const done = agents.filter((a) => a.status === "done");
  const blocked = agents.filter((a) => a.online && a.status === "blocked");
  const emitted = emitMachine(args, {
    room,
    online: online.length,
    done: done.length,
    blocked: blocked.map((a) => ({ name: a.name, note: a.statusNote })),
    messages: store.maxMessageId(room),
    agents: agents.map((a) => ({ name: a.name, status: a.status, online: a.online })),
  });
  if (emitted) return;
  console.log(
    `${bold(room)}: ${online.length} online, ${done.length} done, ${blocked.length} blocked, ` +
      `${store.maxMessageId(room)} messages`,
  );
  for (const agent of blocked) {
    console.log(`  ${yellow("blocked")} ${safe(agent.name)}${agent.statusNote ? dim(` — ${safe(agent.statusNote)}`) : ""}`);
  }
}

async function log(args: Args, room: string): Promise<void> {
  const store = new Morse();
  const limit = Number(args.flags.n ?? args.flags.lines ?? 40);
  const follow = Boolean(args.flags.f ?? args.flags.follow);

  const initial = store.history(room, { limit });
  for (const message of initial) console.log(formatMessage(message), "\n");

  if (!follow) return;

  let cursor = initial.length ? initial[initial.length - 1]!.id : store.maxMessageId(room);
  console.log(dim(`— following room ${room}, ctrl-c to stop —\n`));

  for (;;) {
    const fresh = store.history(room, { sinceId: cursor, limit: 200 });
    for (const message of fresh) {
      console.log(formatMessage(message), "\n");
      cursor = message.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

function rooms(args: Args): void {
  const store = new Morse();
  const all = store.listRooms();
  if (emitMachine(args, { rooms: all })) return;
  if (all.length === 0) {
    console.log("No rooms yet.");
    return;
  }
  for (const entry of all) {
    console.log(`${bold(entry.name.padEnd(24))} ${dim(`${entry.agents} agents · ${entry.messages} messages`)}`);
  }
}

/**
 * Morse ships no roles, so this reports what the machine actually has and where
 * it looked — which is the only way to explain precedence when a project role
 * shadows a shared one, or when a definition someone wrote for another tool
 * turns up here.
 */
/** One line per candidate morse found and would not load, and why. */
function reportRejections(rejected: RoleRejection[], write = console.log): void {
  for (const entry of rejected) {
    const from = entry.plugin ? `${yellow(safe(entry.plugin))} ` : "";
    write(`${yellow("skipped")} ${from}${dim(entry.path)} — ${safe(entry.reason)}`);
  }
}

function roles(args: Args): void {
  if (args.positional[0] === "new") return newRole(args.positional[1]);

  const { roles: found, rejected } = collectRoles();
  if (found.length === 0) {
    console.log("No role definitions found.\n");
    console.log("Morse does not ship roles — an agent works fine without one, and describes");
    console.log("itself over the bus. To define one:\n");
    console.log(`  ${bold("morse roles new backend")}\n`);
  } else {
    for (const entry of found) {
      console.log(`${bold(safe(entry.name).padEnd(16))} ${safe(entry.role ?? "")}`);
      if (entry.description) console.log(`  ${wrapText(safe(entry.description), 76, "  ")}`);
      if (entry.skills.length) console.log(`  ${dim(safe(entry.skills.join(" · ")))}`);
      // Borrowed definitions are labelled; morse's own are not, because the
      // absence of a label is what "I wrote this for morse" looks like.
      const origin = entry.plugin ? `${yellow(safe(entry.plugin))} ${dim(entry.source)}` : dim(entry.source);
      console.log(`  ${origin}\n`);
    }
  }

  if (rejected.length) {
    console.log(dim("Found but not loaded:"));
    reportRejections(rejected);
    console.log("");
  }

  // A manifest in this repository redefined a built-in ecosystem. Legitimate,
  // and the reason project manifests exist — but it changes where morse looks
  // for someone else's agent folders, and it may have arrived with a clone.
  for (const override of roleSearchOverrides()) {
    console.log(
      `${yellow("note")} ${safe(override.path)} redefines the built-in ${bold(safe(override.id))} plugin\n`,
    );
  }

  console.log(dim("Looked up in order:"));
  if (!pluginsEnabled()) {
    // Off means off, down to the bytes: with discovery disabled this is the
    // same short, self-chosen list it has always been, and annotating it would
    // make "the same as before" a claim you had to take on trust.
    for (const path of roleSearchPaths()) console.log(dim(`  ${path}`));
    return;
  }
  // Plugins turn a list you wrote into a list morse assembled, so it has to say
  // which directories were not there. A role that did not appear is nearly
  // always a folder morse never looked in, and that is invisible otherwise.
  for (const entry of roleSearchReport()) {
    const label = entry.plugin ? ` ${yellow(safe(entry.plugin))}` : "";
    console.log(`${dim(`  ${entry.dir}`)}${label}${entry.exists ? "" : dim(" (absent)")}`);
  }
}

function newRole(name: string | undefined): void {
  if (!name) {
    console.error("Usage: morse roles new <name>");
    process.exitCode = 1;
    return;
  }
  if (!isValidRoleName(name)) {
    // The name becomes a filename; refuse anything that could become a path.
    console.error(`Invalid role name '${name}'. Use letters, digits, dot, dash or underscore.`);
    process.exitCode = 1;
    return;
  }
  const dir = join(process.cwd(), ".morse", "roles");
  const path = join(dir, `${name.toLowerCase()}.md`);
  if (existsSync(path)) {
    console.error(`${path} already exists.`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, roleTemplate(name));
  console.log(`Wrote ${bold(path)}\n`);
  console.log("Frontmatter is published to the roster; the body is private guidance for");
  console.log(`that agent. Then: ${bold(`morse join ${name.toLowerCase()}`)}`);
}

function prompt(args: Args, room: string): void {
  const name = args.positional[0];
  if (!name) {
    console.error("Usage: morse prompt <agent>");
    process.exitCode = 1;
    return;
  }
  // Same lookup `morse join` does, so the same refusals have to surface here —
  // this is the command someone runs to find out what their agent will be told.
  // Rejections go to stderr, never stdout: this output gets piped into a
  // harness, and a warning mixed into it would become part of a system prompt.
  const found = findRole(name);
  reportRejections(found.rejected, console.error);
  // Asked for by name, found, and refused, with nothing to fall back on — the
  // request failed even though a usable role-less prompt still prints. Exiting
  // zero here is what makes the failure invisible to anything but a careful
  // reader. A rejection that was superseded by a role further up the ladder is
  // worth mentioning but is not a failure.
  if (found.rejected.length && !found.role) process.exitCode = 1;
  console.log(buildPrompt({ name, room, role: found.role }));
}

// ------------------------------------------------------------ participation

/**
 * Who this invocation speaks as.
 *
 * An identity, if one was assigned — `send` and `ask` are agent verbs too, and
 * a CLI-transport agent running `morse send` must speak as itself rather than
 * as the human. Without one, you are the human, and the human is a first-class
 * member of the room rather than a special case.
 */
function speaker(store: Morse, room: string, args: Args): string {
  const assigned = process.env.MORSE_AGENT?.trim();
  const requested = typeof args.flags.as === "string" ? args.flags.as.trim() : "";
  const name = (assigned || requested).trim().toLowerCase();
  if (!name) return operator(store, room);

  store.register({
    room,
    name,
    harness: process.env.MORSE_HARNESS ?? "cli",
    pid: harnessPid(),
    cwd: process.cwd(),
  });
  return name;
}

/**
 * The human is a first-class member of the room, not a special case: `operator`
 * registers like any agent so the six can address questions back at you.
 */
function operator(store: Morse, room: string): string {
  const name = process.env.MORSE_OPERATOR ?? "operator";
  store.register({
    room,
    name,
    role: "Human operator",
    description: "The human running this session. Ask for decisions only a human can make.",
    skills: ["decisions", "priorities", "final-say"],
    harness: "cli",
  });
  return name;
}

async function send(args: Args, room: string): Promise<void> {
  const [to, ...rest] = args.positional;
  const body = rest.join(" ");
  if (!to || !body) {
    console.error(`Usage: morse send <agent|'*'> <message>`);
    process.exitCode = 1;
    return;
  }
  const store = new Morse();
  const me = speaker(store, room, args);
  const recipients = normalizeRecipients(to.split(","));
  const unknown = await store.unknownRecipients(room, recipients);
  const message = store.send({ room, sender: me, to: recipients, body });
  console.log(`${dim("sent")} #${message.id} → ${recipients.includes(BROADCAST) ? "all" : recipients.join(", ")}`);
  if (unknown.length) console.log(yellow(`  warning: not in this room: ${unknown.join(", ")}`));
}

async function ask(args: Args, room: string): Promise<void> {
  const [to, ...rest] = args.positional;
  const body = rest.join(" ");
  if (!to || !body) {
    console.error(`Usage: morse ask <agent> <question>`);
    process.exitCode = 1;
    return;
  }
  const store = new Morse();
  const me = speaker(store, room, args);
  const timeout = Number(args.flags.timeout ?? 120) * 1000;
  const sent = store.send({ room, sender: me, to: [to], body, kind: "ask" });
  console.error(dim(`asked ${to}, waiting up to ${Math.round(timeout / 1000)}s…`));

  const result = await waitForReply(store.bus, room, me, sent.threadId, sent.id, { timeoutMs: timeout });

  // The interrupted case is the one that loses mail if it is glossed over: the
  // question is still unanswered *and* `inbox` has already advanced the cursor
  // past everything it drained. Structured output makes that impossible to
  // skim past, and the exit code lets a shell loop branch without parsing.
  const view = args.flags.toon
    ? (m: Message) => renderMessage(m, me)
    : (m: Message) => renderMessage(m);
  const emitted = emitMachine(args, {
    outcome: result.outcome,
    thread_id: sent.threadId,
    reply: result.reply ? view(result.reply) : undefined,
    inbox: result.inbox.map(view),
    hint: hintForAsk(result.outcome, sent.threadId),
  });
  if (!emitted) {
    for (const message of result.inbox) console.log(formatMessage(message), "\n");
    if (result.reply) console.log(formatMessage(result.reply));
    if (result.inbox.length > 0 && !result.reply) {
      console.log(yellow(`\n${result.inbox.length} message(s) arrived instead, and are now marked read.`));
    }
    console.log(dim(hintForAsk(result.outcome, sent.threadId)));
  }
  process.exitCode = exitFor(result.outcome);
}

// ------------------------------------------------------------------- setup

function init(room: string): void {
  const path = join(process.cwd(), ".mcp.json");
  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as typeof config;
    } catch {
      console.error(`${path} exists but is not valid JSON. Fix or remove it first.`);
      process.exitCode = 1;
      return;
    }
  }

  config.mcpServers ??= {};
  config.mcpServers.morse = { command: process.execPath, args: [cliPath, "mcp"] };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

  console.log(`Wrote ${bold(".mcp.json")} (room ${cyan(room)}).\n`);
  console.log("With this in place, a plain `claude` session picks up morse. Set your identity first:\n");
  console.log(`  ${bold("MORSE_AGENT=backend claude")}\n`);
  console.log(`Or skip both and let morse wire it up for you:\n`);
  console.log(`  ${bold("morse join backend")}\n`);
}

/**
 * Deleting a room is not recoverable, and the room is resolved from the current
 * directory — so a reset run from the wrong place, or with a mistyped --room,
 * silently destroys a different room's history than the one intended. Show what
 * is about to go, and require --force when there is no terminal to confirm at.
 */
async function reset(args: Args, room: string): Promise<void> {
  const store = new Morse();
  const agents = store.roster(room);
  const messages = store.maxMessageId(room);

  if (agents.length === 0 && messages === 0) {
    console.log(`Room ${cyan(room)} is already empty.`);
    return;
  }

  console.log(`This deletes ${bold(String(agents.length))} agents and all messages in room ${cyan(room)}.`);
  for (const agent of agents) console.log(`  ${safe(agent.name)} ${dim(`(${agent.status})`)}`);

  if (!args.flags.force) {
    const confirmed = await confirm(`Delete room '${room}'? This cannot be undone. [y/N] `);
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  store.clearRoom(room);
  console.log(`Cleared room ${cyan(room)}.`);
}

/** Reads a single line; declines rather than assuming yes when not a terminal. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("Not a terminal. Re-run with --force to confirm.");
    return false;
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// -------------------------------------------------------------------- util

/**
 * Flags that never take a value. Without this, `morse join --no-plugins backend`
 * parses the agent name as the flag's argument and then reports that no agent
 * was given — the option and the positional cannot both survive otherwise.
 */
const BOOLEAN_FLAGS = new Set(["no-plugins", "force", "help", "version", "follow", "json", "toon", "no-registry"]);

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const passthrough: string[] = [];
  let afterSeparator = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (afterSeparator) {
      passthrough.push(token);
      continue;
    }
    if (token === "--") {
      afterSeparator = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && !BOOLEAN_FLAGS.has(key)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && key !== "f") {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(token);
  }

  const [command = "", ...rest] = positional;
  return { command, positional: rest, flags, passthrough };
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}
