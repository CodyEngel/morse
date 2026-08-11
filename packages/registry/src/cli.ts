#!/usr/bin/env node
import { FileRegistry, registryRoot } from "./registry.js";
import { collectRoles, roleSearchReport } from "./discovery.js";
import { resolveRoom, sanitizeRoom } from "./room.js";

/**
 * `morse-registry` — the directory, on its own.
 *
 * JSON by default and single-purpose, because this is not a second copy of the
 * `morse` CLI. It is here so the registry can be driven and inspected with no
 * bus in the picture: if `morse-registry list` is right and `morse roster` is
 * wrong, the bug is in composition. Running it in a directory where only
 * @morse-ai/registry is installed also *demonstrates* the zero-dependency
 * claim rather than asserting it — which is exactly what CI does with it.
 */
const HELP = `morse-registry — the morse agent directory, without the bus

  morse-registry list [--room <r>]        Everyone registered, as JSON
  morse-registry get <name>               One record
  morse-registry publish <name> [...]     Write a record
  morse-registry status <name> <state>    Set status
  morse-registry heartbeat <name>         Mark alive now
  morse-registry depart <name>            Clear presence, keep the outcome
  morse-registry forget <room>            Drop a room's records
  morse-registry rooms                    Rooms with records
  morse-registry roles                    Definitions found, and where it looked
  morse-registry where                    The directory records live in

Options:
  --room <name>       Override the room (default: this git repo's name)
  --role, --description, --skills, --harness, --pid, --cwd   Fields for publish
  --note <text>       Attached to status

Every agent record has exactly one writer in normal use: its own process. The
write verbs here let you break that on purpose — records are written whole, so
a concurrent write loses the other version rather than tearing it.`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const booleans = new Set(["help", "version", "json"]);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !booleans.has(key)) {
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
  return { command, positional: rest, flags };
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function text(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.help || args.command === "help" || !args.command) {
    console.log(HELP);
    return;
  }

  const registry = new FileRegistry();
  const room = args.flags.room ? sanitizeRoom(String(args.flags.room)) : resolveRoom();
  const name = args.positional[0];

  const needsName = (): string | undefined => {
    if (!name) {
      console.error(`Usage: morse-registry ${args.command} <name>`);
      process.exitCode = 1;
      return undefined;
    }
    return name;
  };

  switch (args.command) {
    case "where":
      return out({ root: registryRoot(), room });

    case "list":
      return out({ room, agents: registry.list(room) });

    case "rooms":
      return out({ rooms: registry.listRooms() });

    case "get": {
      const who = needsName();
      if (!who) return;
      const agent = registry.get(room, who);
      if (!agent) {
        console.error(`No agent '${who}' in room '${room}'.`);
        process.exitCode = 1;
        return;
      }
      return out(agent);
    }

    case "publish": {
      const who = needsName();
      if (!who) return;
      const skills = text(args.flags, "skills")?.split(",").map((s) => s.trim()).filter(Boolean);
      const pid = Number(text(args.flags, "pid"));
      const { agent, firstTime } = registry.publish({
        room,
        name: who,
        role: text(args.flags, "role"),
        description: text(args.flags, "description"),
        skills,
        harness: text(args.flags, "harness"),
        pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
        cwd: text(args.flags, "cwd"),
      });
      return out({ agent, first_time: firstTime });
    }

    case "status": {
      const who = needsName();
      if (!who) return;
      const state = args.positional[1];
      if (!state || !["idle", "working", "blocked", "done", "offline"].includes(state)) {
        console.error("Usage: morse-registry status <name> <idle|working|blocked|done|offline>");
        process.exitCode = 1;
        return;
      }
      registry.setStatus(room, who, state as never, text(args.flags, "note") ?? null);
      return out(registry.get(room, who) ?? null);
    }

    case "heartbeat": {
      const who = needsName();
      if (!who) return;
      registry.heartbeat(room, who);
      return out(registry.get(room, who) ?? null);
    }

    case "depart": {
      const who = needsName();
      if (!who) return;
      registry.depart(room, who);
      return out(registry.get(room, who) ?? null);
    }

    case "forget": {
      const target = name ?? room;
      registry.forgetRoom(target);
      return out({ forgot: target });
    }

    case "roles": {
      const { roles, rejected } = collectRoles();
      return out({ roles, rejected, searched: roleSearchReport() });
    }

    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
