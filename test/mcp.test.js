import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  // until it describes itself.
  const poEntry = roster.agents.find((a) => a.name === "product-owner");
  assert.equal(poEntry.expertise, null);
  assert.deepEqual(poEntry.skills, []);
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

test("wait returns empty with room status when nothing arrives", async () => {
  const lonely = client("lonely", "quiet-room");
  await lonely.initialize();

  const result = await lonely.call("morse_wait", { timeout_seconds: 1 });
  assert.equal(result.messages.length, 0);
  assert.ok(Array.isArray(result.room_status));
  assert.match(result.hint, /done/);
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

  const roster = await a.call("morse_roster");
  const me = roster.agents.find((x) => x.name === "handshake-harness");
  assert.equal(me.harness, "codex", "client name should be normalized onto the roster");
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
