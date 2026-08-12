import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "./helpers/client.js";

const tmp = mkdtempSync(join(tmpdir(), "morse-mcp-"));
const DB = join(tmp, "mcp.db");
const clients = [];

function client(name, room = "mcp-room", env = {}) {
  const c = new McpClient({
    MORSE_DB: DB,
    MORSE_AGENT: name,
    MORSE_ROOM: room,
    MORSE_WAIT_SECONDS: "5",
    ...env,
  });
  clients.push(c);
  return c;
}

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  rmSync(tmp, { recursive: true, force: true });
});

test("handshake reports the tools a harness can call", async () => {
  const a = client("handshake-agent", "handshake-room");
  const init = await a.initialize();

  assert.equal(init.serverInfo.name, "morse");
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.ok(init.capabilities.tools);

  const { tools } = await a.request("tools/list");
  const names = tools.map((t) => t.name);
  for (const expected of ["morse_register", "morse_roster", "morse_send", "morse_ask", "morse_wait"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object schema`);
    assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`);
  }
});

test("an unsupported protocol version falls back rather than failing the handshake", async () => {
  const a = client("version-agent", "version-room");
  const init = await a.request("initialize", {
    protocolVersion: "1999-01-01",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  });
  assert.equal(init.protocolVersion, "2025-06-18");
});

test("agents register on startup and see each other's expertise", async () => {
  // Morse ships no roles: identity comes from MORSE_AGENT, and expertise from
  // whatever launched the agent (a role file, via `morse join`).
  const po = client("product-owner", "discovery-room");
  const backend = client("backend", "discovery-room", {
    MORSE_ROLE: "Backend Engineer",
    MORSE_DESCRIPTION: "Owns APIs, data modelling, SQL, and query performance.",
    MORSE_SKILLS: "sql,api-design,performance",
  });
  await Promise.all([po.initialize(), backend.initialize()]);

  const roster = await po.call("morse_roster");
  const names = roster.agents.map((a) => a.name).sort();
  assert.deepEqual(names, ["backend", "product-owner"]);

  const backendEntry = roster.agents.find((a) => a.name === "backend");
  assert.match(backendEntry.expertise, /SQL/i);
  assert.ok(backendEntry.skills.includes("sql"));

  // An agent launched without a role still joins; it just has nothing published
  // until it describes itself. Empty fields are omitted, not shipped as nulls.
  const poEntry = roster.agents.find((a) => a.name === "product-owner");
  assert.equal(poEntry.expertise, undefined);
  assert.equal(poEntry.skills, undefined);
});

test("a message sent by one process is delivered to another", async () => {
  const a = client("sender", "delivery-room");
  const b = client("receiver", "delivery-room");
  await Promise.all([a.initialize(), b.initialize()]);

  await a.call("morse_send", { to: ["receiver"], body: "the index is live", subject: "done" });

  const inbox = await b.call("morse_inbox");
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].from, "sender");
  assert.equal(inbox.messages[0].body, "the index is live");
});

test("sending to a name that is not in the room warns instead of failing silently", async () => {
  const a = client("warner", "warn-room");
  await a.initialize();
  const result = await a.call("morse_send", { to: ["nobody"], body: "hello?" });
  assert.match(result.warning, /not in this room/i);
});

test("ask blocks until the other process replies", async () => {
  const qe = client("qe", "ask-room");
  const backend = client("backend", "ask-room");
  await Promise.all([qe.initialize(), backend.initialize()]);

  const asking = qe.call("morse_ask", {
    to: "backend",
    body: "what does the endpoint return for zero rows?",
    timeout_seconds: 10,
  });

  // The replier parks on morse_wait exactly as a real agent would.
  const waited = await backend.call("morse_wait", { timeout_seconds: 10 });
  assert.equal(waited.messages.length, 1);
  const threadId = waited.messages[0].thread_id;
  await backend.call("morse_reply", { thread_id: threadId, body: "an empty array with a 200" });

  const answer = await asking;
  assert.equal(answer.outcome, "replied");
  assert.equal(answer.reply.from, "backend");
  assert.equal(answer.reply.body, "an empty array with a 200");
});

test("an empty wait is nearly free, and never tells a workless agent to stop", async () => {
  const lonely = client("lonely", "quiet-room");
  await lonely.initialize();

  const result = await lonely.call("morse_wait", { timeout_seconds: 1 });
  assert.equal(result.messages.length, 0);
  assert.equal(result.room_status, undefined, "the per-cycle status block is gone; deltas carry changes");
  assert.match(result.hint, /park|not been given work/i);
  assert.doesNotMatch(result.hint, /'done' and stop/);

  // Coaching is said once; the steady state of an idle room costs almost nothing.
  const again = await lonely.call("morse_wait", { timeout_seconds: 1 });
  assert.equal(again.messages.length, 0);
  assert.equal(again.hint, undefined);
});

test("a cancelled wait is abandoned instead of hanging the session", async () => {
  const a = client("cancels", "cancel-room");
  await a.initialize();

  const { id, promise } = a.callRaw("morse_wait", { timeout_seconds: 60 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  a.notify("notifications/cancelled", { requestId: id, reason: "user pressed escape" });

  const started = Date.now();
  const result = await promise;
  assert.ok(Date.now() - started < 5000, "cancellation should return promptly");
  assert.ok(result.structuredContent ?? result.content);
});

test("status changes are visible to peers", async () => {
  const a = client("statuser", "status-room");
  const b = client("watcher", "status-room");
  await Promise.all([a.initialize(), b.initialize()]);

  await a.call("morse_status", { status: "blocked", note: "waiting on watcher" });

  const roster = await b.call("morse_roster");
  const entry = roster.agents.find((x) => x.name === "statuser");
  assert.equal(entry.status, "blocked");
  assert.equal(entry.note, "waiting on watcher");
});

test("leaving marks the agent offline for everyone else", async () => {
  const leaver = new McpClient({ MORSE_DB: DB, MORSE_AGENT: "leaver", MORSE_ROOM: "leave-room" });
  const stayer = client("stayer", "leave-room");
  await Promise.all([leaver.initialize(), stayer.initialize()]);

  await leaver.close();
  await new Promise((resolve) => setTimeout(resolve, 200));

  const roster = await stayer.call("morse_roster");
  const entry = roster.agents.find((x) => x.name === "leaver");
  assert.equal(entry.online, false);
});

test("the harness is taken from the handshake, not guessed from env", async () => {
  // Env sniffing misses any harness that does not pass its own environment to
  // the MCP servers it launches, which is how Codex agents showed up as
  // "unknown" on the roster.
  const a = client("handshake-harness", "harness-room");
  await a.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "Codex CLI", version: "0.147.0" },
  });
  a.notify("notifications/initialized", {});

  // The roster no longer ships harness to models — it is not a routing signal —
  // so read the record itself to prove the normalized name landed.
  const record = JSON.parse(
    readFileSync(join(tmp, "rooms", "harness-room", "agents", "handshake-harness.json"), "utf8"),
  );
  assert.equal(record.harness, "codex", "client name should be normalized onto the record");
});

test("an agent cannot rename itself out of its assigned identity", async () => {
  // A model that picks its own name orphans the identity its teammates are
  // addressing, and shows up twice from a single process.
  const a = client("assigned-name", "identity-room");
  await a.initialize();

  const result = await a.call("morse_register", { name: "root", role: "Primary agent" });
  assert.equal(result.you, "assigned-name");
  assert.match(result.notice, /assigned/i);

  const roster = await a.call("morse_roster");
  assert.deepEqual(roster.agents.map((x) => x.name), ["assigned-name"], "no duplicate identity");
  // The parts an agent legitimately owns still take effect.
  assert.equal(roster.agents[0].role, "Primary agent");
});

test("without an assigned identity an agent may name itself", async () => {
  // The unmanaged path: someone wired the server up by hand with no MORSE_AGENT.
  const a = new McpClient({ MORSE_DB: DB, MORSE_ROOM: "selfnamed-room" });
  clients.push(a);
  await a.initialize();

  const result = await a.call("morse_register", { name: "chose-my-own", role: "Analyst" });
  assert.equal(result.you, "chose-my-own");
  assert.equal(result.notice, undefined);
});

// ----------------------------------------------------------- 0.4.0 behaviour

test("register is the check-in: roster plus waiting mail in one result", async () => {
  const late = client("late", "checkin-room");
  await late.initialize(); // Mailbox opens at startup; nothing is read yet.
  const early = client("early", "checkin-room");
  await early.initialize();
  await early.call("morse_send", { to: ["late"], body: "read this when you arrive" });

  const result = await late.call("morse_register", {});
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].body, "read this when you arrive");
  assert.ok(result.roster.some((a) => a.name === "early"));
  assert.equal(result.registered, undefined, "no echo of the agent's own record");

  // Mail handed over in the register result is delivered mail: it does not reappear.
  const inbox = await late.call("morse_inbox");
  assert.equal(inbox.count, 0);
});

test("the first arrival is told that being early is normal", async () => {
  const first = client("first", "first-room");
  await first.initialize();
  const result = await first.call("morse_register", {});
  assert.match(result.hint, /first one here/i);
  assert.match(result.hint, /do not set status\s+done/i);
  assert.equal(result.messages.length, 0);
});

test("a newcomer's capabilities ride an existing agent's next result", async () => {
  const veteran = client("veteran", "delta-room");
  await veteran.initialize();
  await veteran.call("morse_register", {}); // Roster shown: just itself.

  const newcomer = client("newcomer", "delta-room", {
    MORSE_ROLE: "QE",
    MORSE_DESCRIPTION: "Breaks things on purpose before users can.",
    MORSE_SKILLS: "testing,edge-cases",
  });
  await newcomer.initialize(); // Registers at startup.

  const result = await veteran.call("morse_wait", { timeout_seconds: 1 });
  assert.ok(result.arrived, "the newcomer should ride the wait result");
  const entry = result.arrived.find((a) => a.name === "newcomer");
  assert.match(entry.expertise, /breaks things/i);
  assert.match(entry.skills, /testing/);

  // Once shown, the delta goes quiet.
  const again = await veteran.call("morse_wait", { timeout_seconds: 1 });
  assert.equal(again.arrived, undefined);
});

test("a capability change surfaces like an arrival; a status flip stays slim", async () => {
  const watcher = client("watcher2", "change-room");
  const shifter = client("shifter", "change-room", {
    MORSE_DESCRIPTION: "Owns the checkout flow.",
  });
  await Promise.all([watcher.initialize(), shifter.initialize()]);
  await watcher.call("morse_register", {}); // Baseline: shifter as currently published.

  await shifter.call("morse_status", { status: "working", note: "wiring the cart" });
  let result = await watcher.call("morse_wait", { timeout_seconds: 1 });
  let entry = (result.changed ?? []).find((a) => a.name === "shifter");
  assert.ok(entry, "a status flip should surface");
  assert.equal(entry.status, "working");
  assert.equal(entry.note, "wiring the cart");
  assert.equal(entry.expertise, undefined, "status churn must not re-ship the capability blurb");

  await shifter.call("morse_register", { description: "Owns checkout and now payments too." });
  result = await watcher.call("morse_wait", { timeout_seconds: 1 });
  entry = (result.changed ?? []).find((a) => a.name === "shifter");
  assert.ok(entry, "a capability change should surface");
  assert.match(entry.expertise, /payments/i);
});

test("a workless agent that declares done is corrected, not congratulated", async () => {
  const solo = client("solo", "solo-room");
  await solo.initialize();
  await solo.call("morse_register", {});

  const status = await solo.call("morse_status", { status: "done" });
  assert.match(status.hint, /work yet|long timeout/i);
  assert.doesNotMatch(status.hint, /you can stop/i);
});

test("coaching hints are said once per session", async () => {
  const talker = client("talker", "hint-room");
  const hearer = client("hearer", "hint-room");
  await Promise.all([talker.initialize(), hearer.initialize()]);

  const first = await talker.call("morse_send", { to: ["hearer"], body: "one" });
  assert.ok(first.hint, "the first send teaches");
  const second = await talker.call("morse_send", { to: ["hearer"], body: "two" });
  assert.equal(second.hint, undefined, "the second send does not repeat it");
});

test("the model surface defaults to TOON, and it round-trips", async () => {
  // MORSE_FORMAT: undefined defeats the helper's JSON pin without setting a
  // value — spawn() drops undefined env keys — so this server runs the real
  // 0.4.0 default, not an explicit opt-in.
  const a = new McpClient({
    MORSE_DB: DB,
    MORSE_AGENT: "tooner",
    MORSE_ROOM: "toon-room",
    MORSE_FORMAT: undefined,
  });
  clients.push(a);
  await a.initialize();

  const raw = await a.request("tools/call", { name: "morse_register", arguments: {} });
  const text = raw.content[0].text;
  assert.throws(() => JSON.parse(text), undefined, "the default output must not be JSON");

  // The reference decoder is the conformance bar, here as in test/toon.test.js.
  const { decode } = await import("@toon-format/toon");
  const decoded = decode(text);
  assert.equal(decoded.you, "tooner");
  assert.equal(decoded.room, "toon-room");
  assert.ok(Array.isArray(decoded.roster));
  assert.ok(Array.isArray(decoded.messages));
});

test("a departure rides the delta as a name", async () => {
  const stayer = client("stayer2", "depart-room");
  const leaver = new McpClient({ MORSE_DB: DB, MORSE_AGENT: "leaver2", MORSE_ROOM: "depart-room" });
  clients.push(leaver);
  await Promise.all([stayer.initialize(), leaver.initialize()]);
  await stayer.call("morse_register", {}); // Baseline: leaver2 as shown.

  await leaver.close(); // A clean shutdown says goodbye through onShutdown.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const result = await stayer.call("morse_wait", { timeout_seconds: 1 });
  assert.ok((result.departed ?? []).includes("leaver2"), "the goodbye should ride the next result");
  assert.equal(result.arrived, undefined);
});

test("the delta rides a send, not only a wait", async () => {
  // Stale routing happens on send: an agent deep in its own work touches morse
  // only to send or ask, so the delta must reach it there.
  const busy = client("busy", "sendelta-room");
  await busy.initialize();
  await busy.call("morse_register", {});

  const newbie = client("newbie", "sendelta-room", {
    MORSE_ROLE: "DevOps",
    MORSE_DESCRIPTION: "Owns pipelines and deploys.",
  });
  await newbie.initialize();

  const result = await busy.call("morse_send", { to: ["newbie"], body: "welcome aboard" });
  assert.ok(
    (result.arrived ?? []).some((a) => a.name === "newbie"),
    "a send's result should carry the newcomer",
  );
});

test("the opening turn speaks each transport's language", async () => {
  const { OPENING_TURNS } = await import("../packages/morse-ai/dist/cli/main.js");
  assert.match(OPENING_TURNS.cli, /morse register --toon/);
  assert.doesNotMatch(OPENING_TURNS.cli, /morse_register/, "a CLI session has no MCP tools to call");
  assert.match(OPENING_TURNS.mcp, /morse_register/);
  for (const turn of Object.values(OPENING_TURNS)) {
    assert.match(turn, /do not set status done/i, "neither transport may walk into the done-trap");
  }
});

test("mail interrupts a long park promptly even after poll backoff", async () => {
  const parker = client("parker", "latency-room");
  const pinger = client("pinger", "latency-room");
  await Promise.all([parker.initialize(), pinger.initialize()]);

  const { promise } = parker.callRaw("morse_wait", { timeout_seconds: 60 });
  // Sit past the 5 s threshold where the poll slows to 1 s.
  await new Promise((resolve) => setTimeout(resolve, 6500));
  const before = Date.now();
  await pinger.call("morse_send", { to: ["parker"], body: "wake" });

  const raw = await promise;
  assert.ok(Date.now() - before < 2500, "delivery must end the park within about one backed-off poll");
  const parsed = JSON.parse(raw.content[0].text);
  assert.equal(parsed.messages[0].body, "wake");
});

test("the suite is hermetic against the developer's own morse session", async () => {
  // Morse is developed by people running morse, so MORSE_AGENT is set in the
  // shell that runs `npm test`. If the harness inherited it, the test above
  // would silently flip from "may name itself" to "was assigned a name" — and
  // pass on CI, which has no morse session, while failing on every maintainer's
  // machine. Nothing else pins this down, so pin it here.
  const previous = process.env.MORSE_AGENT;
  process.env.MORSE_AGENT = "ambient-leak";
  try {
    const a = new McpClient({ MORSE_DB: DB, MORSE_ROOM: "hermetic-room" });
    clients.push(a);
    await a.initialize();

    const result = await a.call("morse_register", { name: "declared", role: "Analyst" });
    assert.equal(result.you, "declared", "ambient MORSE_AGENT reached the server under test");
  } finally {
    if (previous === undefined) delete process.env.MORSE_AGENT;
    else process.env.MORSE_AGENT = previous;
  }
});
