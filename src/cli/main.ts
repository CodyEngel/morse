import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runMcpServer } from "../mcp/server.js";
import { buildPrompt } from "../prompt.js";
import { resolveRoom, sanitizeRoom } from "../room.js";
import { listRoles, loadRole, roleSearchPaths, roleTemplate } from "../roles.js";
import { BROADCAST, Store, normalizeRecipients } from "../store.js";
import { VERSION } from "../version.js";
import { waitForReply } from "../wait.js";
import { agentColor, bold, cyan, dim, formatMessage, relativeTime, statusBadge, yellow } from "./format.js";

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
  morse reset                             Clear the room
  morse mcp                               Run the MCP server (harnesses call this)

Options:
  --room <name>   Override the room (default: this git repo's name)
  --help          Show this message

The store is machine-wide at ~/.morse/morse.db; rooms keep projects apart.
Morse ships no roles; \`morse roles\` shows where it looks for them.`;

const OPENING_TURN =
  "Join the room: call morse_register, then morse_roster to see who is here and what they own, " +
  "then morse_inbox. Handle anything waiting for you. When you have nothing left to do, call " +
  "morse_wait and keep following the protocol in your system prompt — do not stop and hand back " +
  "to me while teammates are still working.";

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

  const room = args.flags.room ? sanitizeRoom(String(args.flags.room)) : resolveRoom();

  switch (args.command) {
    case "mcp":
      return runMcpServer();
    case "join":
      return join_(args, room);
    case "roster":
      return roster(room);
    case "log":
      return log(args, room);
    case "send":
      return send(args, room);
    case "ask":
      return ask(args, room);
    case "status":
      return status(room);
    case "rooms":
      return rooms();
    case "roles":
      return roles(args);
    case "prompt":
      return prompt(args, room);
    case "init":
      return init(room);
    case "reset":
      return reset(room);
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
  const role = loadRole(name);
  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  const serverEnv: Record<string, string> = {
    MORSE_AGENT: name,
    MORSE_ROOM: room,
    ...(role?.role ? { MORSE_ROLE: role.role } : {}),
    ...(role?.description ? { MORSE_DESCRIPTION: role.description } : {}),
    ...(role?.skills.length ? { MORSE_SKILLS: role.skills.join(",") } : {}),
    ...(process.env.MORSE_DB ? { MORSE_DB: process.env.MORSE_DB } : {}),
    ...(process.env.MORSE_HOME ? { MORSE_HOME: process.env.MORSE_HOME } : {}),
  };

  const systemPrompt = buildPrompt({ name, room, role });
  const harness = String(args.flags.harness ?? "claude");
  const headless = args.passthrough.some((arg) => arg === "-p" || arg === "--print" || arg === "exec");

  const harnessArgs = buildHarnessArgs({
    harness,
    node: process.execPath,
    cliPath,
    serverEnv,
    systemPrompt,
    passthrough: args.passthrough,
    // Without an opening turn the session registers and then sits at the
    // prompt: present on the roster, accumulating mail, listening to none of
    // it, and indistinguishable from a crash until a human types something.
    opening: headless ? undefined : OPENING_TURN,
  });

  console.log(
    `${dim("morse:")} joining ${agentColor(name)(bold(name))} to room ${cyan(room)} via ${harness}`,
  );

  const child = spawn(harness, harnessArgs, {
    stdio: "inherit",
    env: { ...process.env, MORSE_AGENT: name, MORSE_ROOM: room },
  });

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

function roster(room: string): void {
  const store = new Store();
  const agents = store.roster(room);
  if (agents.length === 0) {
    console.log(`No agents in room ${cyan(room)} yet. Start one with ${bold("morse join <agent>")}.`);
    return;
  }

  console.log(`${bold(`Room ${room}`)} ${dim(`(${agents.filter((a) => a.online).length}/${agents.length} online)`)}\n`);
  for (const agent of agents) {
    const color = agentColor(agent.name);
    const unread = store.unreadCount(room, agent.name);
    const badge = statusBadge(agent);
    const note = agent.statusNote ? dim(` — ${agent.statusNote}`) : "";
    console.log(`${color(bold(agent.name.padEnd(16)))} ${badge}${note}`);
    if (agent.role) console.log(`  ${dim(agent.role)}`);
    if (agent.description) console.log(`  ${wrapText(agent.description, 76, "  ")}`);
    if (agent.skills.length) console.log(`  ${dim(agent.skills.join(" · "))}`);
    console.log(
      `  ${dim(`seen ${relativeTime(agent.lastSeen)}`)}${unread ? yellow(` · ${unread} unread`) : ""}\n`,
    );
  }
}

function status(room: string): void {
  const store = new Store();
  const agents = store.roster(room);
  const online = agents.filter((a) => a.online);
  const done = agents.filter((a) => a.status === "done");
  const blocked = agents.filter((a) => a.online && a.status === "blocked");
  console.log(
    `${bold(room)}: ${online.length} online, ${done.length} done, ${blocked.length} blocked, ` +
      `${store.maxMessageId(room)} messages`,
  );
  for (const agent of blocked) {
    console.log(`  ${yellow("blocked")} ${agent.name}${agent.statusNote ? dim(` — ${agent.statusNote}`) : ""}`);
  }
}

async function log(args: Args, room: string): Promise<void> {
  const store = new Store();
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

function rooms(): void {
  const store = new Store();
  const all = store.listRooms();
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
 * shadows a shared one.
 */
function roles(args: Args): void {
  if (args.positional[0] === "new") return newRole(args.positional[1]);

  const found = listRoles();
  if (found.length === 0) {
    console.log("No role definitions found.\n");
    console.log("Morse does not ship roles — an agent works fine without one, and describes");
    console.log("itself over the bus. To define one:\n");
    console.log(`  ${bold("morse roles new backend")}\n`);
  } else {
    for (const entry of found) {
      console.log(`${bold(entry.name.padEnd(16))} ${entry.role ?? ""}`);
      if (entry.description) console.log(`  ${wrapText(entry.description, 76, "  ")}`);
      if (entry.skills.length) console.log(`  ${dim(entry.skills.join(" · "))}`);
      console.log(`  ${dim(entry.source)}\n`);
    }
  }

  console.log(dim("Looked up in order:"));
  for (const path of roleSearchPaths()) console.log(dim(`  ${path}`));
}

function newRole(name: string | undefined): void {
  if (!name) {
    console.error("Usage: morse roles new <name>");
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
  console.log(buildPrompt({ name, room, role: loadRole(name) }));
}

// ------------------------------------------------------------ participation

/**
 * The human is a first-class member of the room, not a special case: `operator`
 * registers like any agent so the six can address questions back at you.
 */
function operator(store: Store, room: string): string {
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

function send(args: Args, room: string): void {
  const [to, ...rest] = args.positional;
  const body = rest.join(" ");
  if (!to || !body) {
    console.error(`Usage: morse send <agent|'*'> <message>`);
    process.exitCode = 1;
    return;
  }
  const store = new Store();
  const me = operator(store, room);
  const recipients = normalizeRecipients(to.split(","));
  const unknown = store.unknownRecipients(room, recipients);
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
  const store = new Store();
  const me = operator(store, room);
  const timeout = Number(args.flags.timeout ?? 120) * 1000;
  const sent = store.send({ room, sender: me, to: [to], body, kind: "ask" });
  console.log(dim(`asked ${to}, waiting up to ${Math.round(timeout / 1000)}s…\n`));

  const result = await waitForReply(store, room, me, sent.threadId, sent.id, { timeoutMs: timeout });
  for (const message of result.inbox) console.log(formatMessage(message), "\n");
  if (result.reply) {
    console.log(formatMessage(result.reply));
  } else {
    console.log(yellow(`No answer yet. Thread ${sent.threadId} is still open.`));
    process.exitCode = 1;
  }
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

function reset(room: string): void {
  const store = new Store();
  const agents = store.roster(room);
  store.clearRoom(room);
  console.log(`Cleared room ${cyan(room)} (${agents.length} agents, messages deleted).`);
}

// -------------------------------------------------------------------- util

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
      if (next !== undefined && !next.startsWith("-")) {
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
