import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * The CLI is a second transport, not a set of verbs that happen to exist.
 *
 * These run real, separate OS processes — no shared module state, no in-process
 * shortcuts — because that is the only arrangement that proves anything about
 * agents in different terminals. The claim under test is the one the whole
 * approach rests on: an agent with nothing to do can park inside a single shell
 * command and be woken by a peer it shares nothing with but a directory.
 */
const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../packages/morse-ai/dist/cli.js", import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), "morse-cli-"));
const ROOM = "cli-room";

after(() => rmSync(tmp, { recursive: true, force: true }));

/** One `morse` invocation, as a given agent, in its own process. */
function morse(agent, args, { expectFail = false } = {}) {
  return run(process.execPath, [CLI, "--room", ROOM, ...args], {
    env: { ...process.env, MORSE_DB: join(tmp, "cli.db"), MORSE_AGENT: agent, MORSE_PLUGINS: "off" },
  }).catch((error) => {
    if (expectFail) return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
    throw error;
  });
}

const json = (result) => JSON.parse(result.stdout);

test("two processes complete a round trip over the CLI alone", async () => {
  const registered = json(
    await morse("backend", ["register", "--role", "Backend Engineer", "--skills", "sql,api", "--json"]),
  );
  assert.equal(registered.you, "backend");
  await morse("frontend", ["register", "--role", "Frontend Engineer", "--json"]);

  // Route by capability, exactly as over MCP.
  const roster = json(await morse("frontend", ["roster", "--json"]));
  const sqlOwner = roster.agents.find((a) => a.skills.includes("sql"));
  assert.equal(sqlOwner.name, "backend", "the directory is browsable from a shell too");

  const inboxBefore = json(await morse("backend", ["inbox", "--json"]));
  assert.equal(inboxBefore.count, 0, "a fresh joiner starts clean");

  await morse("frontend", ["send", "backend", "does the migration reverse?"]);

  const inbox = json(await morse("backend", ["inbox", "--json"]));
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].from, "frontend", "a CLI agent speaks as itself, not as the operator");
  assert.equal(inbox.messages[0].body, "does the migration reverse?");
});

test("a parked process is woken by a peer it shares nothing with", async () => {
  await morse("waiter", ["register", "--json"]);
  await morse("poker", ["register", "--json"]);

  // The waiter blocks first; the poker is a separate process started after.
  const parked = morse("waiter", ["wait", "--timeout", "20", "--json"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await morse("poker", ["send", "waiter", "wake up"]);

  const woke = json(await parked);
  assert.equal(woke.messages.length, 1, "the block must end on delivery, not on the timeout");
  assert.equal(woke.messages[0].body, "wake up");
});

test("ask reports interrupted distinctly, and hands back the mail it consumed", async () => {
  await morse("asker", ["register", "--json"]);
  await morse("other", ["register", "--json"]);

  // Unrelated mail lands before any answer does. Over MCP this comes back as
  // one structured payload; the CLI has to make it just as impossible to miss,
  // because `inbox` has already advanced the cursor past it.
  await morse("other", ["send", "asker", "unrelated, but already marked read"]);

  const result = await morse("asker", ["ask", "other", "blocking question", "--timeout", "3", "--json"], {
    expectFail: true,
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.outcome, "interrupted");
  assert.equal(result.code, 2, "exit 2 is what lets a shell loop branch without parsing");
  assert.equal(payload.inbox.length, 1);
  assert.equal(payload.inbox[0].body, "unrelated, but already marked read");
  assert.match(payload.hint, /morse_wait|wait/, "and it says how to resume the original question");
});

test("status and departure are visible across processes", async () => {
  await morse("worker", ["register", "--json"]);
  await morse("worker", ["status", "set", "working", "--note", "on the migration", "--json"]);

  const seen = json(await morse("observer", ["register", "--json"])).roster.find((a) => a.name === "worker");
  assert.equal(seen.status, "working");
  assert.equal(seen.note, "on the migration");

  await morse("worker", ["leave", "--json"]);
  const after = json(await morse("observer", ["register", "--json"])).roster.find((a) => a.name === "worker");
  // Presence goes; how the work ended stays. Same guarantee as the MCP path.
  assert.equal(after.online, false);
  assert.equal(after.status, "working");
});

test("identity is assigned, not chosen, on the CLI too", async () => {
  await morse("assigned", ["register", "--json"]);
  const result = await morse("assigned", ["status", "set", "done", "--as", "impostor", "--json"]);
  assert.match(result.stderr, /assigned/, "the override must be reported, not silently applied");

  const roster = json(await morse("assigned", ["register", "--json"])).roster;
  assert.ok(!roster.some((a) => a.name === "impostor"), "no second identity may appear");
});
