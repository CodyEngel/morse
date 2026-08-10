import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../packages/morse-ai/dist/cli.js", import.meta.url));
// realpath'd once at creation: on macOS /var is a symlink to /private/var, so an
// un-resolved fixture root disagrees with the paths the implementation reports.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "morse-rejection-")));

after(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * A file that was found and then dropped must be distinguishable from a file
 * that was never there. Every rejection path discovery has — outside the
 * searched directory, unreadable, unparseable — produces the same silence
 * otherwise, and "morse just didn't find my agents" is unfalsifiable from the
 * user's side. Especially now that morse reads ~/.claude/agents, a directory
 * the user never created for us.
 *
 * These now pin the published contract rather than matching loosely on shape.
 * The three reasons are a closed set — "skipped" with no reason, or a fourth
 * vague reason like "invalid", is the regression this guards against, and a
 * loose /skipped|refused/ would not have caught it.
 */
const REASONS = ["outside the searched directory", "unreadable", "unparseable"];
const REASON = new RegExp(`skipped \\S+ \\S+ — (${REASONS.join("|")})`);
const HEADING = "Found but not loaded:";

/**
 * Returns both streams separately and the exit code, because all three carry
 * part of the contract. `morse prompt` writes its rejection notice to stderr so
 * stdout stays a clean pipeable prompt — a stdout-only helper reads that correct
 * behaviour as a missing feature, which is how this test lied to me once already.
 */
function run(command, root, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...command], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MORSE_ROLES: "/nonexistent", MORSE_HOME: "/nonexistent", HOME: "/nonexistent", ...env },
  });
  return {
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    stdout: result.stdout ?? "",
    status: result.status,
  };
}

/**
 * A repo whose .claude/agents holds one file that discovery must refuse.
 *
 * Fixture directories are named `case-N`, deliberately. `morse roles` prints
 * every directory it searched, so a fixture named "unreadable" or a secret file
 * named "outside-the-tree.md" puts a REASON word into the output via the path
 * alone and every assertion below passes against a build that reports nothing.
 * Keep these names free of any word REASON matches.
 */
let caseId = 0;
function rejecting(build) {
  const root = join(tmp, `case-${++caseId}`);
  const agents = join(root, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(root, "target.md"), "---\nname: backend\n---\n\nSENTINEL-BODY.\n");
  build(agents, root);
  return root;
}

test("morse roles reports a definition that was found and refused, with a reason", () => {
  const root = rejecting((agents, repo) =>
    symlinkSync(join(repo, "target.md"), join(agents, "backend.md")),
  );

  const out = run(["roles"], root).text;
  assert.match(out, /backend/, "the refused candidate must be named, not silently omitted");
  assert.ok(out.includes(HEADING), `rejections need their own heading:\n${out}`);
  assert.match(out, REASON, `a reason from the closed set must accompany it:\n${out}`);
  assert.match(out, /outside the searched directory/, "a symlink escape is 'outside', not a vaguer reason");
});

test("morse roles distinguishes a refusal from an empty result", () => {
  // The control: nothing on disk at all must NOT produce a rejection report.
  // Without this, a test that greps for a reason string passes on a build that
  // prints the reason unconditionally.
  const root = join(tmp, "nothing-here");
  mkdirSync(root, { recursive: true });

  const out = run(["roles"], root).text;
  assert.ok(!REASON.test(out), `nothing was rejected, so nothing should be reported:\n${out}`);
});

test("asking for a refused role by name says so rather than going silent", () => {
  // The moment that matters: the user is asking for a specific role by name.
  // `morse prompt` is `morse join`'s non-launching path — same role lookup,
  // without spawning a harness.
  const root = rejecting((agents, repo) =>
    symlinkSync(join(repo, "target.md"), join(agents, "backend.md")),
  );

  const result = run(["prompt", "backend"], root);
  assert.match(result.text, REASON, `a named request for a refused role must explain itself:\n${result.text}`);

  // stdout is piped into a harness as a system prompt, so the notice must go to
  // stderr — printed on stdout it would literally become agent instructions,
  // the exact class of problem rejection reporting exists to prevent.
  assert.ok(!result.stdout.includes("skipped"), "the notice must not land in the piped prompt");
  assert.ok(!result.text.includes("SENTINEL-BODY"), "the refused body must never reach the prompt");

  // Load-bearing: a refused role with no fallback exits non-zero. A future
  // refactor that "tidies" this to 0 would make the failure silent to scripts.
  assert.equal(result.status, 1, "a named role that was found and refused must exit non-zero");
});

/**
 * A project manifest may replace a built-in by id — that is the whole point of
 * `.morse/plugins/*.json`, and from $MORSE_HOME it is exactly right. But a
 * project manifest comes from a repo that may have been cloned, and silently
 * redefining what `claude` means is the same class of surprise that provenance
 * labelling and rejection reporting exist to prevent. Disclosure, not a veto:
 * the behaviour stays, the user gets told.
 */
/**
 * Built inline rather than via rejecting(): nothing here is rejected, and that
 * helper's stray file would be noise in a test about what the output says.
 *
 * Note there is no `/claude/` assertion. `morse roles` prints every directory it
 * searched, and the built-in claude rung is `{root}/.claude/agents` — so the
 * word appears unconditionally, with or without an override, and asserting on
 * it would pass against a build that discloses nothing. Only the manifest
 * filename distinguishes disclosure from the baseline.
 */
function overriding(root, withManifest) {
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "agents", "backend.md"),
    "---\nname: backend\ndescription: Real.\n---\n\nGuidance.\n",
  );
  if (withManifest) {
    mkdirSync(join(root, ".morse", "plugins"), { recursive: true });
    // Redefines the built-in `claude` to look somewhere else entirely.
    writeFileSync(
      join(root, ".morse", "plugins", "claude.json"),
      JSON.stringify({ id: "claude", project: [".elsewhere/agents"] }),
    );
  }
  return root;
}

test("a project manifest that replaces a built-in is disclosed, with the file that did it", () => {
  const root = overriding(join(tmp, `case-${++caseId}`), true);

  const out = run(["roles"], root).text;
  assert.match(
    out,
    /claude\.json/,
    `the manifest that overrode a built-in must be identified:\n${out}`,
  );
  assert.match(out, /redefines the built-in claude plugin/, "the disclosure must say what it redefined");
});

test("no manifest means no override disclosure", () => {
  // The control. Without it, a build that merely lists `.morse/plugins` among
  // the directories it searched would satisfy the test above with zero
  // disclosure implemented.
  const root = overriding(join(tmp, `case-${++caseId}`), false);

  const out = run(["roles"], root).text;
  assert.ok(!/claude\.json/.test(out), `nothing was overridden, so nothing should be disclosed:\n${out}`);
});

test("an unreadable entry is reported as unreadable, not as absent", () => {
  const root = rejecting((agents) =>
    // A directory named like a role file: readdir offers it, reading it fails.
    mkdirSync(join(agents, "backend.md"), { recursive: true }),
  );

  const out = run(["roles"], root).text;
  assert.match(out, /unreadable/, `an unreadable candidate must say so specifically:\n${out}`);
  assert.match(out, REASON, `and it must use the published format:\n${out}`);
});
