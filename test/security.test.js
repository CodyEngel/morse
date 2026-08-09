import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "morse-sec-"));
process.env.MORSE_DB = join(tmp, "sec.db");

const { Store, resetDb, loadRole, isValidRoleName, isInside } = await import("../dist/index.js");
const { safe, formatMessage } = await import("../dist/cli/format.js");

const ESC = "\x1b";
const BEL = "\x07";

after(() => {
  resetDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("control characters in a message cannot reach the terminal", () => {
  // OSC 52 writes to the user's clipboard; CSI 2K + CR erases the line and lets
  // an agent forge convincing output in morse's own voice.
  const attack = `benign${ESC}]52;c;bWFsaWNpb3Vz${BEL}${ESC}[2K\rmorse: all agents converged`;
  const rendered = formatMessage({
    id: 1,
    room: "r",
    threadId: "t",
    replyTo: null,
    sender: "attacker",
    kind: "message",
    subject: null,
    body: attack,
    createdAt: Date.now(),
    to: ["*"],
  });

  assert.ok(!rendered.includes(`${ESC}]`), "no OSC sequence survives");
  assert.ok(!rendered.includes(BEL), "no BEL survives");
  assert.ok(!rendered.includes("\r"), "no carriage return survives");
  // Visible rather than silently dropped, so tampering is obvious.
  assert.match(rendered, /\^\[/);
  assert.match(rendered, /benign/);
});

test("escapes are stripped from names, subjects and status notes too", () => {
  assert.equal(safe(`a${ESC}[31mred`), "a^[[31mred");
  assert.equal(safe(`bell${BEL}`), "bell^G");
  assert.equal(safe("del\x7f"), "del^?");
  // Tabs and newlines are legitimate content and must survive.
  assert.equal(safe("keep\tthis\nand this"), "keep\tthis\nand this");
});

test("a message with escapes is stored verbatim but rendered safely", () => {
  // Escaping belongs at the boundary, not in the store: a consumer that is not
  // a terminal should still get exactly what the agent wrote.
  const store = new Store();
  store.register({ room: "esc", name: "a" });
  const body = `x${ESC}[31m`;
  store.send({ room: "esc", sender: "a", to: ["*"], body });

  assert.equal(store.history("esc", { limit: 1 })[0].body, body, "store keeps the raw text");
  assert.ok(!formatMessage(store.history("esc", { limit: 1 })[0]).includes(`${ESC}[31m`));
});

test("a role name cannot escape the roles directory", () => {
  // The body of a role file becomes system-prompt instructions, so reading one
  // from outside the directory is a prompt-injection primitive, not a file read.
  assert.equal(isValidRoleName("../../etc/passwd"), false);
  assert.equal(isValidRoleName("..\\..\\notes"), false);
  assert.equal(isValidRoleName("/absolute"), false);
  assert.equal(isValidRoleName("backend"), true);
  assert.equal(isValidRoleName("data-science_2.0"), true);

  assert.equal(loadRole("../../secret/notes", tmp), undefined);
  assert.equal(isInside("/a/b", "/a/b/../c"), false);
  assert.equal(isInside("/a/b", "/a/b/c.md"), true);
});

test("the store is not readable by other accounts", () => {
  const store = new Store();
  store.register({ room: "perm", name: "a" });
  store.send({ room: "perm", sender: "a", to: ["*"], body: "sensitive" });

  // Everything agents quote at each other lands here in plaintext. This is not a
  // boundary against the same user, but it must not be world-readable.
  const mode = statSync(process.env.MORSE_DB).mode & 0o777;
  assert.equal(mode & 0o077, 0, `expected no group/other access, got ${mode.toString(8)}`);
});
