import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The bus depends on an interface it defines itself, not on @morse-ai/registry.
 * These tests are the design's own check: the bus runs against a stub carrying
 * *exactly* the four port methods, so anything it reaches for beyond them
 * throws `TypeError: ... is not a function` right here instead of quietly
 * widening the contract.
 *
 * A permissive stub — one with a spare `get()` on it "just in case" — would
 * pass while proving nothing. The key set is asserted directly for that reason.
 */
const tmp = mkdtempSync(join(tmpdir(), "morse-port-"));
process.env.MORSE_DB = join(tmp, "port.db");

const { Bus, unregistered, waitForInbox, waitForReply, resetDb } = await import(
  "../packages/bus/dist/index.js"
);

const ROOM = "port-room";

/** `unregistered`, plus a record of what was asked of it. Four keys, no more. */
function stubRegistry(names = []) {
  const calls = [];
  const statuses = new Map();
  return {
    calls,
    registry: {
      heartbeat(room, name) {
        calls.push(["heartbeat", room, name]);
      },
      names(room) {
        calls.push(["names", room]);
        return names;
      },
      status(room, name) {
        calls.push(["status", room, name]);
        return statuses.get(name);
      },
      setStatus(room, name, status, note) {
        calls.push(["setStatus", room, name, status, note ?? null]);
        statuses.set(name, status);
      },
    },
  };
}

let bus;
let stub;

beforeEach(() => {
  stub = stubRegistry(["a", "b"]);
  bus = new Bus({ registry: stub.registry });
  bus.clearRoom(ROOM);
});

after(() => {
  resetDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("the port is exactly four methods", () => {
  // If this number goes up, the bus grew a new demand on the outside world and
  // every third-party registry silently stopped conforming.
  assert.deepEqual(Object.keys(stub.registry).sort(), ["heartbeat", "names", "setStatus", "status"]);
  assert.deepEqual(Object.keys(unregistered).sort(), ["heartbeat", "names", "setStatus", "status"]);
});

test("a full round trip needs nothing beyond the port", async () => {
  bus.join(ROOM, "a");
  bus.join(ROOM, "b");

  bus.send({ room: ROOM, sender: "a", to: ["b"], body: "the migration is reversible" });
  const inbox = bus.inbox(ROOM, "b");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].body, "the migration is reversible");

  // Every registry interaction the bus makes, in one place.
  await bus.heartbeat(ROOM, "a");
  await bus.setStatus(ROOM, "a", "blocked", "waiting on b");
  assert.equal(await bus.status(ROOM, "a"), "blocked");
  assert.deepEqual(await bus.unknownRecipients(ROOM, ["a", "ghost"]), ["ghost"]);

  const used = new Set(stub.calls.map((c) => c[0]));
  assert.deepEqual([...used].sort(), ["heartbeat", "names", "setStatus", "status"]);
});

test("the wait loop heartbeats through the port and nothing else", async () => {
  bus.join(ROOM, "a");
  stub.calls.length = 0;

  const waiting = waitForInbox(bus, ROOM, "a", { timeoutMs: 400, pollMs: 20 });
  setTimeout(() => bus.send({ room: ROOM, sender: "b", to: ["a"], body: "here" }), 60);
  const messages = await waiting;

  assert.equal(messages.length, 1);
  assert.ok(
    stub.calls.some((c) => c[0] === "heartbeat"),
    "parking must keep the agent looking alive to its peers",
  );
  assert.deepEqual([...new Set(stub.calls.map((c) => c[0]))], ["heartbeat"]);
});

test("deadlock avoidance does not consult the registry at all", async () => {
  // `ask` returns early when unrelated mail arrives. That is driven by the
  // inbox, never by status — which is why an unregistered bus keeps it.
  const solo = new Bus({ registry: unregistered });
  solo.clearRoom("solo-room");
  solo.join("solo-room", "x");
  solo.join("solo-room", "y");

  const asked = solo.send({ room: "solo-room", sender: "x", to: ["y"], body: "?", kind: "ask" });
  solo.send({ room: "solo-room", sender: "y", to: ["x"], body: "unrelated" });

  const result = await waitForReply(solo, "solo-room", "x", asked.threadId, asked.id, {
    timeoutMs: 300,
    pollMs: 20,
  });
  assert.equal(result.outcome, "interrupted");
  assert.equal(result.inbox.length, 1);
  assert.equal(result.inbox[0].body, "unrelated");
});

test("an unregistered bus delivers mail but publishes no presence", async () => {
  const solo = new Bus({ registry: unregistered });
  solo.clearRoom("quiet-room");
  solo.join("quiet-room", "x");
  solo.join("quiet-room", "y");

  solo.send({ room: "quiet-room", sender: "x", to: ["y"], body: "still works" });
  assert.equal(solo.inbox("quiet-room", "y").length, 1, "delivery does not need a registry");

  // The three things running without one actually costs.
  assert.equal(await solo.status("quiet-room", "x"), undefined);
  // An empty roster yields no warnings rather than warning about everyone: a
  // hint that fires on every recipient of every send is noise, not information.
  assert.deepEqual(await solo.unknownRecipients("quiet-room", ["nobody"]), [], "no warnings");
  await solo.heartbeat("quiet-room", "x"); // a no-op, and must not throw
});

test("re-joining leaves the cursor alone", () => {
  bus.join(ROOM, "a");
  bus.send({ room: ROOM, sender: "b", to: ["a"], body: "one" });
  assert.equal(bus.inbox(ROOM, "a").length, 1);

  // A reconnect must not hand back what was already read, nor skip what was not.
  bus.send({ room: ROOM, sender: "b", to: ["a"], body: "two" });
  const again = bus.join(ROOM, "a");
  assert.equal(again.firstTime, false);
  assert.equal(bus.inbox(ROOM, "a").length, 1, "only the message that arrived while away");
});

test("a first join starts at the high-water mark, not at the backlog", () => {
  bus.join(ROOM, "a");
  for (let i = 0; i < 5; i++) bus.send({ room: ROOM, sender: "a", to: ["*"], body: `old ${i}` });

  const late = bus.join(ROOM, "latecomer");
  assert.equal(late.firstTime, true);
  assert.equal(bus.inbox(ROOM, "latecomer").length, 0, "the backlog is history, not mail");
  assert.equal(bus.history(ROOM).length > 0, true, "but it is still readable");
});
