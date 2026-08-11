import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Each package ships a CLI, and they are not three copies of the same surface.
 * `morse` is the product; these two are the executable form of each half's
 * contract — how you drive one layer with the other out of the picture, and how
 * you tell a composition bug from a storage one.
 */
const run = promisify(execFile);
const BUS = fileURLToPath(new URL("../packages/bus/dist/cli.js", import.meta.url));
const REGISTRY = fileURLToPath(new URL("../packages/registry/dist/cli.js", import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), "morse-subcli-"));
const env = { ...process.env, MORSE_HOME: tmp, MORSE_DB: join(tmp, "s.db"), MORSE_ROOM: "sub", MORSE_PLUGINS: "off" };

after(() => rmSync(tmp, { recursive: true, force: true }));

const cli = (bin, args, { expectFail = false } = {}) =>
  run(process.execPath, [bin, ...args], { env }).catch((error) => {
    if (expectFail) return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
    throw error;
  });

const json = (result) => JSON.parse(result.stdout);

test("the registry CLI works with no bus in the picture", async () => {
  await cli(REGISTRY, ["publish", "backend", "--role", "Backend Engineer", "--skills", "sql,api"]);
  await cli(REGISTRY, ["status", "backend", "working", "--note", "on it"]);

  const listed = json(await cli(REGISTRY, ["list"]));
  const backend = listed.agents.find((a) => a.name === "backend");
  assert.equal(backend.role, "Backend Engineer");
  assert.deepEqual(backend.skills, ["sql", "api"]);
  assert.equal(backend.status, "working");
  assert.equal(backend.statusNote, "on it");

  await cli(REGISTRY, ["depart", "backend"]);
  const departed = json(await cli(REGISTRY, ["get", "backend"]));
  assert.equal(departed.online, false, "presence goes");
  assert.equal(departed.status, "working", "how the work ended stays");
});

test("the bus CLI refuses to guess at a registry", async () => {
  // The library makes `registry` a required argument so going without one is
  // chosen. The CLI mirrors that rather than silently degrading — a bus with no
  // presence looks exactly like a room where everyone crashed.
  const result = await cli(BUS, ["--registry", "./nothing-here", "join", "a"], { expectFail: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /could not load/);
  assert.match(result.stderr, /--no-registry/, "and it says how to proceed deliberately");
});

test("the bus CLI always reports which registry it resolved", async () => {
  const withRegistry = await cli(BUS, ["rooms"]);
  assert.match(withRegistry.stderr, /registry: @morse-ai\/registry@/, "named, with a version");

  const without = await cli(BUS, ["--no-registry", "rooms"]);
  assert.match(without.stderr, /registry: none/);
  assert.match(without.stderr, /no presence/, "and what that costs");

  // Reporting goes to stderr so the JSON on stdout stays machine-readable.
  assert.doesNotThrow(() => json(withRegistry));
  assert.doesNotThrow(() => json(without));
});

test("the bus CLI delivers with no registry at all", async () => {
  await cli(BUS, ["--no-registry", "join", "x"]);
  await cli(BUS, ["--no-registry", "join", "y"]);
  await cli(BUS, ["--no-registry", "send", "y", "x", "delivery does not need a directory"]);

  const inbox = json(await cli(BUS, ["--no-registry", "inbox", "x"]));
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].body, "delivery does not need a directory");
});

test("both bins answer --help without a database or a room", async () => {
  // The cheapest possible packaging check: a missing shebang, a lost chmod or a
  // files array that omits the entry point all show up here rather than at
  // `npm i -g`.
  for (const bin of [BUS, REGISTRY]) {
    const help = await cli(bin, ["--help"]);
    assert.match(help.stdout, /^morse-(bus|registry) —/m);
  }
});
