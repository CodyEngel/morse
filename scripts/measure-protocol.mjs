#!/usr/bin/env node
/**
 * Phase 0 of docs/plans/0.4.0/efficiency.md: measure what the protocol costs.
 *
 * Drives the real MCP server (packages/morse-ai/dist/cli.js, via the same
 * McpClient the test suite uses) through three scripted scenarios and records
 * the EXACT text a model would read — `result.content[0].text` of every
 * tools/call, byte-counted as UTF-8, never re-serialized or re-formatted.
 *
 * Scenarios:
 *   cold-start     the 0.3.x opening turn: register -> roster -> inbox -> wait
 *   busy-exchange  two agents, 5 ask/reply cycles, then a broadcast + drain
 *   idle-hour      one empty wait, projected over the ~72 empty parks that a
 *                  50 s default park produces in an idle hour
 *
 * Message bodies are fixed strings so before/after runs compare apples to
 * apples. Everything runs against a fresh mkdtemp MORSE_HOME/MORSE_DB per run
 * (one subdirectory per scenario, so scenarios cannot pollute each other);
 * ~/.morse is never touched.
 *
 * Usage: node scripts/measure-protocol.mjs [--out <path>]
 *   --out writes the full JSON dump, including every per-call record with its
 *   raw result text.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "../test/helpers/client.js";
import { encodeToon } from "../packages/morse-ai/dist/toon.js";

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  console.error(`node >= 22 required (running ${process.versions.node})`);
  process.exit(1);
}

const ROOM = "measure";

// ---------------------------------------------------------------- fixed cast

const BACKEND_ENV = {
  MORSE_AGENT: "backend",
  MORSE_ROLE: "Backend Engineer",
  MORSE_DESCRIPTION:
    "Owns the service APIs and the data layer: endpoint contracts, SQL query design, " +
    "schema migrations, and data modelling for every service in this repo.",
  MORSE_SKILLS: "sql,api-design,performance",
};

const FRONTEND_ENV = {
  MORSE_AGENT: "frontend",
  MORSE_ROLE: "Frontend Engineer",
  MORSE_DESCRIPTION:
    "Owns the web client: React components, state and routing, CSS layout and theming, " +
    "and accessibility. Ask here about rendering and browser quirks.",
  MORSE_SKILLS: "react,css,accessibility",
};

// ------------------------------------------------------ fixed message bodies

/** ~200 chars each; frontend -> backend. */
const QUESTIONS = [
  "For the /orders endpoint, what does the response body look like when the requested page is past " +
    "the end of the data? I need to know whether the client should render an empty state or treat it " +
    "as an error.",
  "Which column should the orders list sort by when the user has not chosen one? Created-at " +
    "descending feels right, but I need to know what the index supports so pagination stays stable " +
    "under concurrent writes.",
  "When an order row has no customer attached, does the API return the customer field as null or " +
    "omit the key entirely? The list view needs to know which shape to expect before I write the " +
    "empty-cell renderer.",
  "What is the maximum page size the API will accept for /orders, and does it clamp silently or " +
    "reject with a 400? I want the page-size selector to only offer values the backend will " +
    "actually honour at runtime.",
  "Do cursor tokens for /orders pagination expire, and if so how should the client recover when a " +
    "stored cursor goes stale? I need to decide between silently restarting at page one and showing " +
    "a refresh prompt.",
];

/** ~300 chars each; backend -> frontend, on the ask's thread. */
const ANSWERS = [
  "Past-the-end pages return a 200 with an empty items array, total_count still set, and " +
    "next_cursor null - never a 404. Render the empty state, keep the pager visible, and disable " +
    "the next button when next_cursor is null. Errors are reserved for malformed cursors, which " +
    "come back as a 400 with a code field.",
  "Default sort is created_at descending with id descending as the tiebreaker, and the composite " +
    "index (created_at, id) backs it, so pagination stays stable under concurrent inserts. Do not " +
    "offer arbitrary column sorts yet; only created_at and total have indexes today, and anything " +
    "else would table-scan.",
  "The customer field is always present and is null when no customer is attached - we never omit " +
    "keys, so your renderer can rely on the shape. Treat null as a walk-in sale and render a dash " +
    "in the cell. The same rule holds across the API: absent data is an explicit null, never a " +
    "missing property, by contract.",
  "Page size is clamped to 100: anything larger is silently reduced, never rejected, and the " +
    "effective value is echoed back as page_size in the response meta. Offer 10, 25, 50, and 100 " +
    "in the selector and read the echoed value rather than assuming. Zero and negatives get a 400 " +
    "with code invalid_page_size.",
  "Cursors are signed and expire after 24 hours; a stale or tampered one gets a 410 with code " +
    "cursor_expired, distinct from the 400 for malformed input. On a 410, silently restart at page " +
    "one and show a toast that results were refreshed. Do not retry the dead cursor - the " +
    "signature check makes that pointless.",
];

/** ~200 chars; backend -> ["*"]. */
const BROADCAST_BODY =
  "Heads up team: the /orders contract is settled - empty pages return 200 with an empty items " +
  "array, page size clamps at 100, and cursors expire after 24 hours with a 410. Details are on " +
  "the ask threads.";

// The 0.3.x default park is 50 s, so an idle hour is ~72 empty wait returns,
// each of which is a full model turn. `morse join` sizes Claude Code parks at
// 270 s from 0.4.0 on, which is ~13 turns for the same idle hour.
const IDLE_TURNS_PER_HOUR = 72;
const IDLE_TURNS_270 = Math.round(3600 / 270);

// -------------------------------------------------------------- measurement

/**
 * Records one scenario's tool calls in fire order. `start` sends the request
 * immediately (via callRaw) and returns a promise, so a call can be left
 * parked — a morse_wait — while another client acts.
 */
function makeRecorder(scenario) {
  const records = [];
  const start = (client, agent, tool, args) => {
    const rec = { seq: records.length + 1, agent, tool, args };
    records.push(rec);
    const { promise } = client.callRaw(tool, args);
    return promise.then((result) => {
      if (result.isError) {
        throw new Error(
          `[${scenario}] ${agent} ${tool} failed: ${result.content?.[0]?.text ?? "(no text)"}`,
        );
      }
      const text = result.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error(`[${scenario}] ${agent} ${tool}: result has no text content`);
      }
      // The one measurement that matters: the exact bytes the model reads.
      rec.result_bytes = Buffer.byteLength(text, "utf8");
      rec.text = text;

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      // The run is pinned to JSON so the flow can be driven off parsed results;
      // the TOON figure re-encodes the same object with the same encoder the
      // server uses, which yields byte-identical text to a TOON-format session.
      rec.toon_bytes =
        parsed === undefined ? rec.result_bytes : Buffer.byteLength(encodeToon(parsed), "utf8");
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        throw new Error(`[${scenario}] ${agent} ${tool} returned an error payload: ${parsed.error}`);
      }
      return { rec, parsed };
    });
  };
  return { scenario, records, start };
}

/** Bytes of user content the caller handed in — everything else is protocol. */
function payloadBytes(args) {
  return typeof args.body === "string" ? Buffer.byteLength(args.body, "utf8") : 0;
}

function totals(recorder) {
  const result_bytes = recorder.records.reduce((n, r) => n + r.result_bytes, 0);
  const toon_bytes = recorder.records.reduce((n, r) => n + (r.toon_bytes ?? r.result_bytes), 0);
  const payload_bytes = recorder.records.reduce((n, r) => n + payloadBytes(r.args), 0);
  return {
    calls: recorder.records.length,
    result_bytes,
    toon_bytes,
    est_tokens: Math.round(result_bytes / 4),
    est_toon_tokens: Math.round(toon_bytes / 4),
    payload_bytes,
    overhead_bytes: result_bytes - payload_bytes,
  };
}

/** A per-scenario MORSE_HOME under the per-run mkdtemp root. */
function scenarioEnv(root, scenario, roleEnv) {
  const home = join(root, scenario);
  mkdirSync(home, { recursive: true });
  return {
    ...roleEnv,
    MORSE_ROOM: ROOM,
    MORSE_HOME: home,
    MORSE_DB: join(home, "morse.db"),
  };
}

// ----------------------------------------------------------------- scenarios

/** The opening turn as OPENING_TURN prescribes it in 0.3.x. */
async function coldStart(root) {
  const recorder = makeRecorder("cold-start");
  const client = new McpClient(scenarioEnv(root, "cold-start", BACKEND_ENV));
  try {
    await client.initialize();
    await recorder.start(client, "backend", "morse_register", {});
    await recorder.start(client, "backend", "morse_roster", {});
    await recorder.start(client, "backend", "morse_inbox", {});
    await recorder.start(client, "backend", "morse_wait", { timeout_seconds: 1 });
  } finally {
    await client.close();
  }
  return recorder;
}

/** Two agents: 5 parked-wait/ask/reply cycles, then a broadcast and a drain. */
async function busyExchange(root) {
  const recorder = makeRecorder("busy-exchange");
  const env = (roleEnv) => scenarioEnv(root, "busy-exchange", roleEnv);
  const backend = new McpClient(env(BACKEND_ENV));
  const frontend = new McpClient(env(FRONTEND_ENV));
  try {
    // Both servers register themselves at startup; after both handshakes the
    // roster deterministically holds two agents.
    await backend.initialize();
    await frontend.initialize();
    await recorder.start(backend, "backend", "morse_register", {});
    await recorder.start(frontend, "frontend", "morse_register", {});

    for (let i = 0; i < QUESTIONS.length; i++) {
      // Backend parks first; the promise stays un-awaited while frontend asks.
      const parked = recorder.start(backend, "backend", "morse_wait", { timeout_seconds: 30 });
      const asked = recorder.start(frontend, "frontend", "morse_ask", {
        to: "backend",
        body: QUESTIONS[i],
        timeout_seconds: 30,
      });

      const { parsed: waitResult } = await parked; // resolves when the ask lands
      const ask = waitResult.messages?.[0];
      if (!ask?.thread_id) {
        throw new Error(`[busy-exchange] cycle ${i + 1}: backend's wait did not deliver the ask`);
      }
      await recorder.start(backend, "backend", "morse_reply", {
        thread_id: ask.thread_id,
        body: ANSWERS[i],
      });

      const { parsed: askResult } = await asked; // the reply resolves the ask
      if (askResult.outcome !== "replied") {
        throw new Error(`[busy-exchange] cycle ${i + 1}: ask ended '${askResult.outcome}', expected 'replied'`);
      }
    }

    await recorder.start(backend, "backend", "morse_send", { to: ["*"], body: BROADCAST_BODY });
    await recorder.start(frontend, "frontend", "morse_wait", { timeout_seconds: 5 });
  } finally {
    await Promise.all([backend.close(), frontend.close()]);
  }
  return recorder;
}

/** One empty park; the hourly figure is that result times 72. */
async function idleHour(root) {
  const recorder = makeRecorder("idle-hour");
  const client = new McpClient(scenarioEnv(root, "idle-hour", BACKEND_ENV));
  try {
    await client.initialize();
    await recorder.start(client, "backend", "morse_register", {});
    await recorder.start(client, "backend", "morse_wait", { timeout_seconds: 1 });
    // The steady state: the coaching hint was said on the first empty return.
    await recorder.start(client, "backend", "morse_wait", { timeout_seconds: 1 });
  } finally {
    await client.close();
  }
  return recorder;
}

/** The opening turn as OPENING_TURNS prescribes it from 0.4.0 on. */
async function coldStart04(root) {
  const recorder = makeRecorder("cold-start-0.4");
  const client = new McpClient(scenarioEnv(root, "cold-start-04", BACKEND_ENV));
  try {
    await client.initialize();
    await recorder.start(client, "backend", "morse_register", {});
    await recorder.start(client, "backend", "morse_wait", { timeout_seconds: 1 });
  } finally {
    await client.close();
  }
  return recorder;
}

// ------------------------------------------------------------------- output

const fmt = (n) => n.toLocaleString("en-US");
const pad = (value, width) => String(value).padStart(width);

function printReport(recorders) {
  const rows = recorders.map((r) => ({ name: r.scenario, ...totals(r) }));

  console.log(`morse protocol cost (room "${ROOM}", fresh store per scenario; json run, toon derived)`);
  console.log("");
  console.log("scenario         calls   json bytes   toon bytes   est. tokens (toon)");
  console.log("--------------   -----   ----------   ----------   ------------------");
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(14)}   ${pad(row.calls, 5)}   ${pad(fmt(row.result_bytes), 10)}   ${pad(fmt(row.toon_bytes), 10)}   ${pad(fmt(row.est_toon_tokens), 18)}`,
    );
  }

  for (const recorder of recorders) {
    console.log("");
    console.log(`${recorder.scenario} - per call`);
    const label = (r) => `${r.agent} ${r.tool}`;
    const width = Math.max(...recorder.records.map((r) => label(r).length));
    for (const r of recorder.records) {
      console.log(
        `  ${String(r.seq).padStart(2)}. ${label(r).padEnd(width)}   ${pad(fmt(r.result_bytes), 8)} B json` +
          `   ${pad(fmt(r.toon_bytes ?? r.result_bytes), 8)} B toon` +
          (payloadBytes(r.args) > 0 ? `   (carried ${fmt(payloadBytes(r.args))} B of body)` : ""),
      );
    }

    const t = totals(recorder);
    if (recorder.scenario === "busy-exchange") {
      const pct = Math.round((t.overhead_bytes / t.result_bytes) * 100);
      console.log(
        `  split: payload ${fmt(t.payload_bytes)} B | overhead ${fmt(t.overhead_bytes)} B ` +
          `(${pct}% of result bytes is protocol, not content)`,
      );
    }
    if (recorder.scenario === "idle-hour") {
      // The steady-state park is the LAST wait: the first empty return carries
      // the once-only coaching, every one after it is the real hourly cost.
      const waits = recorder.records.filter((r) => r.tool === "morse_wait");
      const steady = waits[waits.length - 1];
      const hourly03 = steady.result_bytes * IDLE_TURNS_PER_HOUR;
      const hourly04 = steady.toon_bytes * IDLE_TURNS_270;
      console.log(
        `  steady-state empty wait = ${fmt(steady.result_bytes)} B json / ${fmt(steady.toon_bytes)} B toon`,
      );
      console.log(
        `  at the 0.3.x cadence (50 s park, ${IDLE_TURNS_PER_HOUR} turns/hour): ${fmt(hourly03)} B (~${fmt(Math.round(hourly03 / 4))} tokens)/hour`,
      );
      console.log(
        `  at the 0.4.0 cadence (270 s park, ${IDLE_TURNS_270} turns/hour): ${fmt(hourly04)} B (~${fmt(Math.round(hourly04 / 4))} tokens)/hour`,
      );
    }
  }
}

function buildDump(recorders) {
  const versionOf = (pkg) => {
    const file = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", pkg, "package.json");
    return JSON.parse(readFileSync(file, "utf8")).version;
  };
  // The steady-state park (the once-only coaching rides the first empty wait).
  const idleWait = recorders
    .find((r) => r.scenario === "idle-hour")
    .records.filter((r) => r.tool === "morse_wait")
    .at(-1);

  return {
    generated_at: new Date().toISOString(),
    node: process.versions.node,
    morse_version: versionOf("morse-ai"),
    room: ROOM,
    tokens_estimate: "bytes / 4, rounded",
    scenarios: recorders.map((recorder) => ({
      name: recorder.scenario,
      totals: totals(recorder),
      ...(recorder.scenario === "idle-hour"
        ? {
            projection: {
              turns_per_hour: IDLE_TURNS_PER_HOUR,
              turns_per_hour_270: IDLE_TURNS_270,
              empty_wait_bytes: idleWait.result_bytes,
              empty_wait_toon_bytes: idleWait.toon_bytes,
              hourly_bytes: idleWait.result_bytes * IDLE_TURNS_PER_HOUR,
              hourly_bytes_04: idleWait.toon_bytes * IDLE_TURNS_270,
            },
          }
        : {}),
      calls: recorder.records.map((r) => ({
        seq: r.seq,
        agent: r.agent,
        tool: r.tool,
        args: r.args,
        payload_bytes: payloadBytes(r.args),
        result_bytes: r.result_bytes,
        toon_bytes: r.toon_bytes,
        text: r.text,
      })),
    })),
  };
}

// --------------------------------------------------------------------- main

function parseOut(argv) {
  const i = argv.indexOf("--out");
  if (i === -1) return undefined;
  const path = argv[i + 1];
  if (!path || path.startsWith("--")) {
    console.error("--out requires a path");
    process.exit(1);
  }
  return resolve(path);
}

async function main() {
  const outPath = parseOut(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), "morse-measure-"));

  try {
    const recorders = [];
    recorders.push(await coldStart(root));
    recorders.push(await coldStart04(root));
    recorders.push(await busyExchange(root));
    recorders.push(await idleHour(root));

    printReport(recorders);

    if (outPath) {
      writeFileSync(outPath, `${JSON.stringify(buildDump(recorders), null, 2)}\n`);
      console.log("");
      console.log(`full dump written to ${outPath}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
