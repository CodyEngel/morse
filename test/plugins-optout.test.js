import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "morse-optout-"));

// One of the accepted off values; plugins.test.js is what pins the full set
// (`0`, `off`, `false`, `no`). Here the value is incidental — this file is
// about what the opt-out does, not what spells it.
const DISCOVERY_OFF = { MORSE_PLUGINS: "off" };

after(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * The real bytes `morse roles` printed before discovery existed, captured from
 * this same fixture and with the temp root normalized to {ROOT}. The promise
 * being kept is that opting out is byte-identical to v0.1.1, so this is
 * compared as a whole string rather than sampled with a few `includes` — a
 * reformatted line, a reordered ladder or a dropped description all have to
 * fail it.
 *
 * What this gate is FOR, so the next person does not misread it: it proves the
 * opt-out genuinely disables the new code path rather than merely hiding its
 * results. A failure means "the opt-out is leaking" — go look at what plugin
 * code ran with discovery off.
 *
 * What it is NOT: a permanent freeze on `morse roles` formatting. If someone
 * later improves this command's output on purpose, re-capture the golden
 * against the new baseline. That is a normal update, not a violation. Capture
 * it from a build of the released tag (`git archive v0.1.1 | tar -x`), never
 * from the working tree's dist/, or the gate quietly measures nothing.
 */
const GOLDEN = readFileSync(new URL("./fixtures/roles-v0.1.1.txt", import.meta.url), "utf8");

function fixture() {
  const root = join(tmp, "fix");
  mkdirSync(join(root, ".morse", "roles"), { recursive: true });
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".morse", "roles", "backend.md"),
    "---\nrole: Backend Engineer\ndescription: Owns APIs.\nskills: [sql, api-design]\n---\n\nGuidance.\n",
  );
  writeFileSync(
    join(root, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews code.\ntools: [Read]\n---\n\nReview guidance.\n",
  );
  return root;
}

function roles(root, env = {}) {
  return execFileSync(process.execPath, [CLI, "roles"], {
    cwd: root,
    encoding: "utf8",
    // Pin every ambient root: the point of this test is that output depends on
    // the fixture and nothing else.
    env: { ...process.env, MORSE_ROLES: "/nonexistent", MORSE_HOME: "/nonexistent", HOME: "/nonexistent", ...env },
  });
}

test("with discovery off, morse roles matches v0.1.1 exactly", () => {
  const root = fixture();
  const out = roles(root, DISCOVERY_OFF).replaceAll(realpathSync(root), "{ROOT}").replaceAll(root, "{ROOT}");

  // Named checks first, so a failure says what went wrong before dumping a diff:
  // the .claude definition is on disk and must be invisible, and a user who
  // opted out must not even see plugin directories reported as searched.
  assert.ok(!out.includes("reviewer"), "a borrowed definition leaked with discovery off");
  assert.ok(!out.includes(".claude"), "opted-out output must not mention plugin directories");

  assert.equal(out, GOLDEN, "output drifted from the recorded v0.1.1 bytes");
});

test("with discovery on, the same fixture gains the borrowed definition", () => {
  // The other half of the pair: proves the opt-out is actually toggling
  // something, rather than the fixture simply having nothing to discover.
  const root = fixture();
  const out = roles(root);

  assert.ok(out.includes("reviewer"), "discovery on should surface .claude/agents/reviewer.md");
  assert.ok(out.includes("backend"), "morse's own role is still listed");
});
