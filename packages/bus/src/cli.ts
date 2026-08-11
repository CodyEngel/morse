#!/usr/bin/env node
import { createRequire } from "node:module";
import { Bus, normalizeRecipients } from "./bus.js";
import { unregistered, type Registry } from "./registry.js";
import { renderMessage } from "./mcp.js";
import { waitForInbox, waitForReply } from "./wait.js";

/**
 * `morse-bus` — the log, on its own.
 *
 * JSON by default, single-purpose, and deliberately not a second copy of the
 * `morse` CLI. It exists so the bus can be driven with no registry in the
 * picture, and so "this package depends on nothing" is something you can run
 * rather than something you read.
 */
const HELP = `morse-bus — the morse message log, without the registry

  morse-bus join <name>                   Open a mailbox (announces the first time)
  morse-bus send <name> <to> <message>    Send; '*' broadcasts
  morse-bus ask <name> <to> <question>    Send and block for an answer
  morse-bus reply <name> <thread> <text>  Answer on a thread
  morse-bus inbox <name>                  Unread mail, without blocking
  morse-bus wait <name> [--thread <id>]   Block until mail arrives
  morse-bus thread <id>                   One conversation
  morse-bus history [-n <count>]          Recent traffic
  morse-bus rooms                         Rooms with traffic
  morse-bus clear <room>                  Drop a room's traffic and mailboxes

Options:
  --room <name>          Which room (default: $MORSE_ROOM, else "default")
  --timeout <seconds>    How long to block. Default 50
  --registry <module>    Load a registry from this module
  --no-registry          Run without one, on purpose

A registry supplies presence, recipient warnings and status. Without one those
three stop; delivery, threading, cursors and ask/interrupt do not. The bus
refuses to guess: pass --no-registry if that is what you want.

Exit codes for ask/wait: 0 replied, 2 interrupted, 1 timed out.`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const booleans = new Set(["help", "version", "no-registry"]);

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
    if (token.startsWith("-") && token.length > 1) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
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

/**
 * Which registry to talk to, and say so out loud.
 *
 * The library makes `registry` a required argument so that going without one is
 * chosen rather than defaulted into; the CLI mirrors that. If nothing resolves
 * it errors instead of quietly degrading, and it always reports what it picked,
 * because "no presence" is otherwise indistinguishable from "everyone crashed".
 */
async function resolveRegistry(flags: Record<string, string | boolean>): Promise<Registry | undefined> {
  if (flags["no-registry"]) {
    console.error("registry: none — no presence, no recipient warnings, no status");
    return unregistered;
  }

  const specifier = typeof flags.registry === "string" ? flags.registry : "@morse-ai/registry";
  try {
    const module = (await import(specifier)) as { FileRegistry?: new () => Registry; default?: unknown };
    if (typeof module.FileRegistry === "function") {
      let version = "";
      try {
        version = createRequire(import.meta.url)(`${specifier}/package.json`).version;
      } catch {
        // A registry that does not expose its manifest is still a registry.
      }
      console.error(`registry: ${specifier}${version ? `@${version}` : ""}`);
      return new module.FileRegistry();
    }
    console.error(`registry: ${specifier} does not export a FileRegistry constructor.`);
  } catch {
    console.error(
      `registry: could not load ${specifier}.\n` +
        "Install @morse-ai/registry, point --registry at a module, or pass --no-registry to run without one.",
    );
  }
  return undefined;
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function exitFor(outcome: string): number {
  return outcome === "replied" ? 0 : outcome === "interrupted" ? 2 : 1;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.help || args.command === "help" || !args.command) {
    console.log(HELP);
    return;
  }

  const registry = await resolveRegistry(args.flags);
  if (!registry) {
    process.exitCode = 1;
    return;
  }

  const bus = new Bus({ registry });
  const room = String(args.flags.room ?? process.env.MORSE_ROOM ?? "default");
  const timeoutMs = Number(args.flags.timeout ?? 50) * 1000;
  const [a, b, ...rest] = args.positional;

  const needs = (value: string | undefined, usage: string): string | undefined => {
    if (!value) {
      console.error(`Usage: morse-bus ${usage}`);
      process.exitCode = 1;
      return undefined;
    }
    return value;
  };

  switch (args.command) {
    case "join": {
      const me = needs(a, "join <name>");
      if (!me) return;
      return out({ room, name: me, ...bus.join(room, me) });
    }

    case "send": {
      const me = needs(a, "send <name> <to> <message>");
      const to = needs(b, "send <name> <to> <message>");
      const body = rest.join(" ");
      if (!me || !to || !body) return void (process.exitCode = 1);
      const recipients = normalizeRecipients(to.split(","));
      const unknown = await bus.unknownRecipients(room, recipients);
      const message = bus.send({ room, sender: me, to: recipients, body });
      return out({ sent: renderMessage(message), ...(unknown.length ? { unknown } : {}) });
    }

    case "ask": {
      const me = needs(a, "ask <name> <to> <question>");
      const to = needs(b, "ask <name> <to> <question>");
      const body = rest.join(" ");
      if (!me || !to || !body) return void (process.exitCode = 1);
      const sent = bus.send({ room, sender: me, to: [to], body, kind: "ask" });
      await bus.setStatus(room, me, "blocked", `waiting on ${to}`);
      const result = await waitForReply(bus, room, me, sent.threadId, sent.id, { timeoutMs });
      await bus.setStatus(room, me, result.outcome === "replied" ? "working" : "idle");
      out({
        outcome: result.outcome,
        thread_id: sent.threadId,
        reply: result.reply ? renderMessage(result.reply) : undefined,
        inbox: result.inbox.map(renderMessage),
      });
      process.exitCode = exitFor(result.outcome);
      return;
    }

    case "reply": {
      const me = needs(a, "reply <name> <thread> <message>");
      const threadId = needs(b, "reply <name> <thread> <message>");
      const body = rest.join(" ");
      if (!me || !threadId || !body) return void (process.exitCode = 1);
      if (bus.thread(room, threadId, 1).length === 0) {
        console.error(`No thread '${threadId}' in room '${room}'.`);
        process.exitCode = 1;
        return;
      }
      const target = bus.lastSpeaker(room, threadId, me) ?? "*";
      const message = bus.send({ room, sender: me, to: [target], body, kind: "reply", threadId });
      return out({ sent: renderMessage(message) });
    }

    case "inbox": {
      const me = needs(a, "inbox <name>");
      if (!me) return;
      await bus.heartbeat(room, me);
      const messages = bus.inbox(room, me);
      return out({ messages: messages.map(renderMessage), count: messages.length });
    }

    case "wait": {
      const me = needs(a, "wait <name>");
      if (!me) return;
      const threadId = typeof args.flags.thread === "string" ? args.flags.thread : undefined;
      if (threadId) {
        const afterId = bus.lastOwnMessageId(room, threadId, me);
        const result = await waitForReply(bus, room, me, threadId, afterId, { timeoutMs });
        out({
          outcome: result.outcome,
          thread_id: threadId,
          reply: result.reply ? renderMessage(result.reply) : undefined,
          inbox: result.inbox.map(renderMessage),
        });
        process.exitCode = exitFor(result.outcome);
        return;
      }
      const messages = await waitForInbox(bus, room, me, { timeoutMs });
      return out({ messages: messages.map(renderMessage), count: messages.length });
    }

    case "thread": {
      const id = needs(a, "thread <id>");
      if (!id) return;
      return out({ thread_id: id, messages: bus.thread(room, id).map(renderMessage) });
    }

    case "history": {
      const limit = Number(args.flags.n ?? args.flags.lines ?? 40);
      return out({ room, messages: bus.history(room, { limit }).map(renderMessage) });
    }

    case "rooms":
      return out({ rooms: bus.rooms() });

    case "clear": {
      const target = a ?? room;
      bus.clearRoom(target);
      return out({ cleared: target });
    }

    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
