import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "morse-test-"));
process.env.MORSE_DB = join(tmp, "test.db");

const { Morse, resetDb, waitForInbox, waitForReply } = await import("../packages/morse-ai/dist/index.js");

const ROOM = "test-room";
let store;

beforeEach(() => {
  store = new Morse();
  store.clearRoom(ROOM);
});

after(() => {
  resetDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("agents publish capabilities that peers can discover", () => {
  store.register({
    room: ROOM,
    name: "backend",
    role: "Backend Engineer",
    description: "Owns SQL and API performance.",
    skills: ["sql", "performance"],
  });
  store.register({ room: ROOM, name: "frontend", role: "Frontend Engineer", skills: ["css"] });

  const roster = store.roster(ROOM);
  assert.equal(roster.length, 2);

  // The point of the directory: find a teammate by what they know, not by name.
  const sqlOwner = roster.find((a) => a.skills.includes("sql"));
  assert.equal(sqlOwner.name, "backend");
  assert.equal(sqlOwner.description, "Owns SQL and API performance.");
  assert.ok(sqlOwner.online);
});

test("direct messages reach only their recipient", () => {
  for (const name of ["po", "backend", "frontend"]) store.register({ room: ROOM, name });

  store.send({ room: ROOM, sender: "po", to: ["backend"], body: "add an index" });

  assert.equal(store.inbox(ROOM, "backend").length, 1);
  assert.equal(store.inbox(ROOM, "frontend").length, 0);
  assert.equal(store.inbox(ROOM, "po").length, 0);
});

test("reading advances the cursor so messages are not redelivered", () => {
  store.register({ room: ROOM, name: "a" });
  store.register({ room: ROOM, name: "b" });

  store.send({ room: ROOM, sender: "a", to: ["b"], body: "one" });
  assert.equal(store.inbox(ROOM, "b").length, 1);
  assert.equal(store.inbox(ROOM, "b").length, 0);
  assert.equal(store.unreadCount(ROOM, "b"), 0);

  store.send({ room: ROOM, sender: "a", to: ["b"], body: "two" });
  assert.equal(store.unreadCount(ROOM, "b"), 1);
});

test("broadcast reaches everyone except the sender", () => {
  for (const name of ["a", "b", "c"]) store.register({ room: ROOM, name });

  store.send({ room: ROOM, sender: "a", to: ["*"], body: "shipping at 5" });

  assert.equal(store.inbox(ROOM, "b").length, 1);
  assert.equal(store.inbox(ROOM, "c").length, 1);
  assert.equal(store.inbox(ROOM, "a").length, 0);
});

test("a late joiner starts clean but can read the backlog", () => {
  store.register({ room: ROOM, name: "a" });
  store.send({ room: ROOM, sender: "a", to: ["*"], body: "early chatter" });

  store.register({ room: ROOM, name: "latecomer" });

  assert.equal(store.inbox(ROOM, "latecomer").length, 0, "should not be flooded with backlog");
  const history = store.history(ROOM, { limit: 50 });
  assert.ok(history.some((m) => m.body === "early chatter"), "backlog is still readable");
});

test("re-registering keeps the cursor so nothing is lost across a reconnect", () => {
  store.register({ room: ROOM, name: "a" });
  store.register({ room: ROOM, name: "b" });

  store.send({ room: ROOM, sender: "a", to: ["b"], body: "while you were out" });
  store.leave(ROOM, "b", false);
  store.register({ room: ROOM, name: "b" });

  const inbox = store.inbox(ROOM, "b");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].body, "while you were out");
});

test("rooms isolate traffic", () => {
  store.register({ room: ROOM, name: "a" });
  store.register({ room: "other-room", name: "a" });
  store.send({ room: "other-room", sender: "a", to: ["*"], body: "not yours" });

  assert.equal(store.history(ROOM, { limit: 10 }).filter((m) => m.body === "not yours").length, 0);
  store.clearRoom("other-room");
});

// Async since 0.3.0: the bus asks a registry it holds through an interface, and
// that interface tolerates a promise so a remote registry stays implementable.
test("unknown recipients are reported rather than silently swallowed", async () => {
  store.register({ room: ROOM, name: "a" });
  assert.deepEqual(await store.unknownRecipients(ROOM, ["a", "ghost"]), ["ghost"]);
  assert.deepEqual(await store.unknownRecipients(ROOM, ["*"]), []);
});

test("replies target whoever spoke last on the thread", () => {
  store.register({ room: ROOM, name: "qe" });
  store.register({ room: ROOM, name: "backend" });

  const asked = store.send({ room: ROOM, sender: "qe", to: ["backend"], body: "what happens at zero rows?" });
  assert.equal(store.lastSpeaker(ROOM, asked.threadId, "backend"), "qe");
});

test("waitForInbox returns as soon as a message lands", async () => {
  store.register({ room: ROOM, name: "a" });
  store.register({ room: ROOM, name: "b" });

  const parked = waitForInbox(store.bus, ROOM, "b", { timeoutMs: 3000, pollMs: 20 });
  setTimeout(() => store.send({ room: ROOM, sender: "a", to: ["b"], body: "wake up" }), 60);

  const messages = await parked;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "wake up");
});

test("waitForInbox gives up at the timeout instead of hanging", async () => {
  store.register({ room: ROOM, name: "a" });
  const messages = await waitForInbox(store.bus, ROOM, "a", { timeoutMs: 120, pollMs: 20 });
  assert.equal(messages.length, 0);
});

test("waitForReply resolves with the answer to its own thread", async () => {
  store.register({ room: ROOM, name: "qe" });
  store.register({ room: ROOM, name: "backend" });

  const asked = store.send({ room: ROOM, sender: "qe", to: ["backend"], body: "zero rows?", kind: "ask" });
  const parked = waitForReply(store.bus, ROOM, "qe", asked.threadId, asked.id, { timeoutMs: 3000, pollMs: 20 });

  setTimeout(() => {
    store.send({
      room: ROOM,
      sender: "backend",
      to: ["qe"],
      body: "empty array, 200",
      threadId: asked.threadId,
      kind: "reply",
    });
  }, 60);

  const result = await parked;
  assert.equal(result.outcome, "replied");
  assert.equal(result.reply.body, "empty array, 200");
});

test("waitForReply breaks out when unrelated mail arrives, so peers cannot deadlock", async () => {
  for (const name of ["a", "b", "c"]) store.register({ room: ROOM, name });

  const asked = store.send({ room: ROOM, sender: "a", to: ["b"], body: "need a decision", kind: "ask" });
  const parked = waitForReply(store.bus, ROOM, "a", asked.threadId, asked.id, { timeoutMs: 3000, pollMs: 20 });

  // c asks a something while a is parked. Without the early return, a would sit
  // on a reply that b cannot send because b is waiting on a.
  setTimeout(() => store.send({ room: ROOM, sender: "c", to: ["a"], body: "unrelated", kind: "ask" }), 60);

  const result = await parked;
  assert.equal(result.outcome, "interrupted");
  assert.equal(result.inbox.length, 1);
  assert.equal(result.inbox[0].sender, "c");
  assert.equal(result.reply, undefined);
});

test("waitForReply hands back everything it consumed, not just the reply", async () => {
  for (const name of ["a", "b", "c"]) store.register({ room: ROOM, name });

  const asked = store.send({ room: ROOM, sender: "a", to: ["b"], body: "need a decision", kind: "ask" });

  // Both land before a polls, so inbox() returns them as one batch and advances
  // a's cursor past both. The broadcast sits *after* the reply in id order — the
  // position that used to get dropped on the way out.
  store.send({ room: ROOM, sender: "b", to: ["a"], body: "yes", threadId: asked.threadId, kind: "reply" });
  const broadcast = store.send({ room: ROOM, sender: "c", to: ["*"], body: "shipping at 5" });

  const result = await waitForReply(store.bus, ROOM, "a", asked.threadId, asked.id, { timeoutMs: 1000, pollMs: 20 });

  assert.equal(result.outcome, "replied");
  assert.equal(result.reply.body, "yes");

  // The invariant: nothing the cursor moved past is unobservable. A message with
  // an id *higher* than the reply's is expected here.
  assert.deepEqual(
    result.inbox.map((m) => m.id),
    [broadcast.id],
  );
  // And it is genuinely gone from the inbox, so the returned copy is the only one.
  assert.equal(store.inbox(ROOM, "a").length, 0);
});

test("two agents asking each other simultaneously both make progress", async () => {
  store.register({ room: ROOM, name: "x" });
  store.register({ room: ROOM, name: "y" });

  const xAsks = store.send({ room: ROOM, sender: "x", to: ["y"], body: "x->y?", kind: "ask" });
  const yAsks = store.send({ room: ROOM, sender: "y", to: ["x"], body: "y->x?", kind: "ask" });

  const [xResult, yResult] = await Promise.all([
    waitForReply(store.bus, ROOM, "x", xAsks.threadId, xAsks.id, { timeoutMs: 2000, pollMs: 20 }),
    waitForReply(store.bus, ROOM, "y", yAsks.threadId, yAsks.id, { timeoutMs: 2000, pollMs: 20 }),
  ]);

  // Neither hangs: each is handed the other's question instead of blocking.
  assert.equal(xResult.outcome, "interrupted");
  assert.equal(yResult.outcome, "interrupted");
  assert.equal(xResult.inbox[0].sender, "y");
  assert.equal(yResult.inbox[0].sender, "x");
});

test("status is visible to the whole room", () => {
  store.register({ room: ROOM, name: "a" });
  store.setStatus(ROOM, "a", "blocked", "waiting on backend");

  const agent = store.roster(ROOM).find((x) => x.name === "a");
  assert.equal(agent.status, "blocked");
  assert.equal(agent.statusNote, "waiting on backend");
});

test("leaving preserves how the work ended", () => {
  store.register({ room: ROOM, name: "a" });
  store.setStatus(ROOM, "a", "done");
  store.leave(ROOM, "a", false);

  const agent = store.roster(ROOM).find((x) => x.name === "a");
  // A converged room and a crashed one must not look the same once the
  // processes are gone: presence is false, but the outcome survives.
  assert.equal(agent.online, false);
  assert.equal(agent.status, "done");
});

test("a crashed agent is distinguishable from a finished one", () => {
  store.register({ room: ROOM, name: "worker" });
  store.setStatus(ROOM, "worker", "working");
  store.leave(ROOM, "worker", false);

  const agent = store.roster(ROOM).find((x) => x.name === "worker");
  assert.equal(agent.online, false);
  assert.equal(agent.status, "working", "unfinished work should still read as unfinished");
});

test("rejoining clears a terminal status so it cannot fake convergence", () => {
  store.register({ room: ROOM, name: "a" });
  store.setStatus(ROOM, "a", "done");
  store.leave(ROOM, "a", false);

  store.register({ room: ROOM, name: "a" });
  const agent = store.roster(ROOM).find((x) => x.name === "a");
  assert.equal(agent.online, true);
  assert.equal(agent.status, "idle");
});

test("a running session is distinguishable from a crashed one", () => {
  // The state a live agent sits in between launch and its first turn:
  // registered, heartbeat going stale, process very much alive. Judged on the
  // heartbeat alone it is indistinguishable from a crash.
  store.register({ room: ROOM, name: "quiet", pid: process.pid });
  store.register({ room: ROOM, name: "ghost", pid: 2_147_483_600 });

  const roster = store.roster(ROOM);
  assert.equal(roster.find((a) => a.name === "quiet").alive, true, "our own pid is running");
  assert.equal(roster.find((a) => a.name === "ghost").alive, false, "that pid cannot exist");
});

test("a departed agent is not alive even if its pid gets reused", () => {
  store.register({ room: ROOM, name: "gone", pid: process.pid });
  store.leave(ROOM, "gone", false);

  const agent = store.roster(ROOM).find((a) => a.name === "gone");
  assert.equal(agent.alive, false, "an explicit goodbye outranks a pid probe");
  assert.equal(agent.online, false);
});
