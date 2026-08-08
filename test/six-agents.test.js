import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "./helpers/client.js";

/**
 * The acceptance criterion, minus the language model: six independent processes
 * start in parallel, discover each other, route work by expertise, and finish —
 * with no agent owning or supervising another.
 *
 * Each agent below is a plain async function. They share no variables that carry
 * task state; everything they learn about each other travels over the bus.
 */
const tmp = mkdtempSync(join(tmpdir(), "morse-six-"));
const DB = join(tmp, "six.db");
const ROOM = "six-room";
const DEADLINE_MS = 45_000;

const NAMES = ["product-owner", "frontend", "backend", "devops", "secops", "qe"];
const clients = new Map();

after(async () => {
  await Promise.all([...clients.values()].map((c) => c.close()));
  rmSync(tmp, { recursive: true, force: true });
});

/** Poll the roster until everyone has arrived — nobody starts before the team exists. */
async function awaitTeam(client, size, deadline) {
  for (;;) {
    const roster = await client.call("morse_roster");
    if (roster.agents.filter((a) => a.online).length >= size) return roster;
    if (Date.now() > deadline) throw new Error(`only ${roster.agents.length} of ${size} agents appeared`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Park, handle whatever arrives, repeat — the loop a real agent runs. Answers
 * every ask, because leaving one unanswered strands the sender.
 */
async function serve(client, { until, deadline, answer }) {
  const seen = [];
  while (!until(seen) && Date.now() < deadline) {
    const result = await client.call("morse_wait", { timeout_seconds: 2 });
    for (const message of result.messages ?? []) {
      seen.push(message);
      if (message.kind === "ask") {
        await client.call("morse_reply", { thread_id: message.thread_id, body: answer(message) });
      }
    }
  }
  return seen;
}

/**
 * Ask, and see it through — the loop the prompt tells agents to run.
 *
 * A blocking ask deliberately returns early when unrelated mail arrives, so
 * "interrupted" is a normal step, not a failure: handle what came in, then
 * resume waiting on the original thread.
 */
async function askUntilAnswered(client, to, body, deadline) {
  let result = await client.call("morse_ask", { to, body, timeout_seconds: 5 });
  const threadId = result.thread_id;
  let interruptions = 0;

  while (result.outcome !== "replied" && Date.now() < deadline) {
    if (result.outcome === "interrupted") interruptions++;
    for (const message of result.inbox ?? []) {
      if (message.kind === "ask") {
        await client.call("morse_reply", { thread_id: message.thread_id, body: "noted" });
      }
    }
    result = await client.call("morse_wait", { thread_id: threadId, timeout_seconds: 5 });
  }
  return { ...result, interruptions };
}

/** Find a teammate by capability rather than by hardcoded name. */
function whoKnows(roster, skill) {
  const match = roster.agents.find((a) => a.skills.includes(skill));
  assert.ok(match, `nobody in the room claims '${skill}'`);
  return match.name;
}

test("six agents survive a cold start against an empty database", async () => {
  // Regression guard: they all race to create the schema and flip the database
  // into WAL, and losing that race used to kill the agent outright. Repeated,
  // because it only ever failed some of the time.
  for (let round = 0; round < 3; round++) {
    const coldDb = join(mkdtempSync(join(tmpdir(), `morse-cold-${round}-`)), "cold.db");
    const cold = NAMES.map(
      (name) => new McpClient({ MORSE_DB: coldDb, MORSE_AGENT: name, MORSE_ROOM: "cold-room" }),
    );
    try {
      const inits = await Promise.all(cold.map((c) => c.initialize()));
      assert.equal(inits.length, 6);

      const roster = await cold[0].call("morse_roster");
      assert.equal(roster.agents.length, 6, `round ${round}: not everyone registered`);
    } finally {
      await Promise.all(cold.map((c) => c.close()));
    }
  }
});

test("six agents discover each other and collaborate as peers", async (t) => {
  t.diagnostic(`room ${ROOM}`);
  const deadline = Date.now() + DEADLINE_MS;

  // Spawn all six at once. None of them is a parent of any other.
  for (const name of NAMES) {
    clients.set(
      name,
      new McpClient({ MORSE_DB: DB, MORSE_AGENT: name, MORSE_ROOM: ROOM, MORSE_WAIT_SECONDS: "5" }),
    );
  }
  await Promise.all([...clients.values()].map((c) => c.initialize()));

  const results = {};

  const productOwner = async () => {
    const client = clients.get("product-owner");
    await awaitTeam(client, 6, deadline);
    await client.call("morse_send", {
      to: ["*"],
      subject: "TASK",
      body: "Add a paginated /orders endpoint with a matching list view. Ask me if scope is unclear.",
    });
    // Stay available for questions until the rest of the room has finished.
    while (Date.now() < deadline) {
      const roster = await client.call("morse_roster");
      const others = roster.agents.filter((a) => a.name !== "product-owner");
      if (others.length >= 5 && others.every((a) => a.status === "done")) break;

      const result = await client.call("morse_wait", { timeout_seconds: 1 });
      for (const message of result.messages ?? []) {
        if (message.kind === "ask") {
          await client.call("morse_reply", {
            thread_id: message.thread_id,
            body: "Ship page size 25 by default; correctness over speed.",
          });
        }
      }
    }
    await client.call("morse_status", { status: "done" });
  };

  const frontend = async () => {
    const client = clients.get("frontend");
    const roster = await awaitTeam(client, 6, deadline);
    const task = await serve(client, { deadline, answer: () => "noted", until: (seen) => seen.length >= 1 });
    results.frontendSawTask = task.some((m) => m.subject === "TASK");

    // Route by expertise: the frontend has no idea who owns SQL until it looks.
    const sqlOwner = whoKnows(roster, "sql");
    results.sqlOwner = sqlOwner;
    results.frontendAnswer = await askUntilAnswered(
      client,
      sqlOwner,
      "What shape does /orders return when the page is empty?",
      deadline,
    );
    await client.call("morse_status", { status: "done" });
  };

  const backend = async () => {
    const client = clients.get("backend");
    await awaitTeam(client, 6, deadline);
    const seen = await serve(client, {
      deadline,
      answer: () => "An empty items array with a 200 and a null next_cursor.",
      until: (s) => s.some((m) => m.kind === "ask"),
    });
    results.backendSawTask = seen.some((m) => m.subject === "TASK");
    await client.call("morse_status", { status: "done" });
  };

  const qe = async () => {
    const client = clients.get("qe");
    const roster = await awaitTeam(client, 6, deadline);
    const seen = await serve(client, { deadline, answer: () => "noted", until: (s) => s.length >= 1 });
    results.qeSawTask = seen.some((m) => m.subject === "TASK");

    const securityOwner = whoKnows(roster, "threat-modelling");
    results.securityOwner = securityOwner;
    results.qeAnswer = await askUntilAnswered(
      client,
      securityOwner,
      "Can a cursor from one account be replayed against another?",
      deadline,
    );
    await client.call("morse_status", { status: "done" });
  };

  const secops = async () => {
    const client = clients.get("secops");
    await awaitTeam(client, 6, deadline);
    const seen = await serve(client, {
      deadline,
      answer: () => "Only if cursors are unscoped. Sign them with the account id.",
      until: (s) => s.some((m) => m.kind === "ask"),
    });
    results.secopsSawTask = seen.some((m) => m.subject === "TASK");
    await client.call("morse_status", { status: "done" });
  };

  const devops = async () => {
    const client = clients.get("devops");
    await awaitTeam(client, 6, deadline);
    const seen = await serve(client, { deadline, answer: () => "noted", until: (s) => s.length >= 1 });
    results.devopsSawTask = seen.some((m) => m.subject === "TASK");
    await client.call("morse_send", { to: ["*"], body: "Heads up: the orders table is unindexed in staging." });
    await client.call("morse_status", { status: "done" });
  };

  await Promise.all([productOwner(), frontend(), backend(), qe(), secops(), devops()]);

  // --- discovery -----------------------------------------------------------
  assert.equal(results.sqlOwner, "backend", "frontend should locate the SQL owner by capability");
  assert.equal(results.securityOwner, "secops", "qe should locate the security owner by capability");

  // --- broadcast reached the whole team ------------------------------------
  for (const who of ["frontend", "backend", "qe", "secops", "devops"]) {
    assert.equal(results[`${who}SawTask`], true, `${who} never received the broadcast task`);
  }

  // --- peer-to-peer questions got real answers -----------------------------
  assert.equal(results.frontendAnswer.outcome, "replied");
  assert.equal(results.frontendAnswer.reply.from, "backend");
  assert.match(results.frontendAnswer.reply.body, /empty items array/);

  assert.equal(results.qeAnswer.outcome, "replied");
  assert.equal(results.qeAnswer.reply.from, "secops");
  assert.match(results.qeAnswer.reply.body, /Sign them/);

  // --- the room converged --------------------------------------------------
  const finalRoster = await clients.get("product-owner").call("morse_roster");
  const done = finalRoster.agents.filter((a) => a.status === "done").map((a) => a.name).sort();
  assert.deepEqual(done, ["backend", "devops", "frontend", "product-owner", "qe", "secops"]);

  const history = await clients.get("product-owner").call("morse_history", { limit: 100 });
  t.diagnostic(`${history.messages.length} messages exchanged`);
  assert.ok(history.messages.length >= 8);
});
