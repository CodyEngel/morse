import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Every ambient root the ladder can reach is pinned somewhere that does not
// exist. Discovery now reads the cwd, the git root and $HOME, and a test that
// picked up the maintainer's real ~/.claude/agents would pass or fail based on
// whose laptop it ran on.
const tmp = mkdtempSync(join(tmpdir(), "morse-plugins-"));
process.env.MORSE_DB = join(tmp, "plugins.db");
process.env.MORSE_ROLES = join(tmp, "no-such-pack");
process.env.MORSE_HOME = join(tmp, "no-such-home");
process.env.HOME = join(tmp, "no-such-user");
delete process.env.MORSE_PLUGINS;

const { loadRole, listRoles, roleSearchDirs, roleSearchPaths, roleSearchReport } = await import(
  "../packages/morse-ai/dist/index.js"
);

after(() => rmSync(tmp, { recursive: true, force: true }));

function write(path, contents) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

/** A project directory with nothing in it but what a test puts there. */
function project(name) {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  return root;
}

const CLAUDE_BACKEND = `---
name: backend
description: Owns APIs, data modelling, and query performance.
tools: [Read, Edit, Bash]
model: opus
---

You own the API and data layer.
`;

// -------------------------------------------------------------------- it works

test("a Claude subagent is discovered without being copied into .morse/roles", () => {
  // The whole point: `roles.ts` has claimed compatibility with this file shape
  // in a comment since v0.1.0, but a user still had to copy the file by hand.
  const root = project("claude-flat");
  write(join(root, ".claude", "agents", "backend.md"), CLAUDE_BACKEND);

  const role = loadRole("backend", root);
  assert.ok(role, "a populated .claude/agents must be enough on its own");
  assert.equal(role.name, "backend");
  assert.equal(role.description, "Owns APIs, data modelling, and query performance.");
  assert.match(role.brief, /API and data layer/);
  assert.equal(role.plugin, "claude", "provenance travels with the definition");
  assert.equal(role.source, join(root, ".claude", "agents", "backend.md"));

  assert.deepEqual(
    listRoles(root).map((r) => [r.name, r.plugin]),
    [["backend", "claude"]],
  );
});

test("a borrowed role lands with no skills rather than invented ones", () => {
  // `tools:` is a tool allowlist, not a capability blurb, and agents route work
  // by reading skills off the roster. Mapping one onto the other would send the
  // room's questions to whoever happened to be granted Bash.
  const root = project("no-tools-as-skills");
  write(join(root, ".claude", "agents", "backend.md"), CLAUDE_BACKEND);

  const role = loadRole("backend", root);
  assert.deepEqual(role.skills, [], "tools must not become skills");
  assert.equal(role.role, undefined, "claude has no role field; morse does not guess one");
});

// -------------------------------------------------------------- who wins where

test("a morse role shadows a borrowed one at the same rung", () => {
  const root = project("shadowing");
  write(join(root, ".claude", "agents", "backend.md"), CLAUDE_BACKEND);
  write(
    join(root, ".morse", "roles", "backend.md"),
    "---\nrole: Backend Engineer\ndescription: The one we meant.\nskills: [sql]\n---\n\nOurs.\n",
  );

  const role = loadRole("backend", root);
  assert.equal(role.plugin, undefined, "writing the morse file is how you say 'I mean this one'");
  assert.equal(role.description, "The one we meant.");
  assert.deepEqual(role.skills, ["sql"]);

  const listed = listRoles(root).filter((r) => r.name === "backend");
  assert.equal(listed.length, 1, "the shadowed copy must not appear twice");
  assert.equal(listed[0].plugin, undefined);
});

// ----------------------------------------------------- nested, pack-namespaced

test("a pi agent nested under a pack is discovered", () => {
  // pi namespaces agents by pack — agents/<pack>/<name>.md — so flat-only
  // discovery finds nothing here at all.
  const root = project("pi-nested");
  write(
    join(root, ".pi", "agent", "agents", "openspec", "architect.md"),
    "---\nname: architect\ndescription: Designs the change before it is written.\n---\n\nThink first.\n",
  );

  const role = loadRole("architect", root);
  assert.ok(role, "nesting must not hide a definition");
  assert.equal(role.plugin, "pi");
  assert.equal(role.description, "Designs the change before it is written.");
  assert.ok(listRoles(root).some((r) => r.name === "architect" && r.plugin === "pi"));
});

test("two packs defining the same agent resolve first-wins, and both are visible", () => {
  // The loser is not an error, but it must be diagnosable — which means the
  // winner's source path has to say which pack it came from.
  const root = project("pi-collision");
  const agents = join(root, ".pi", "agent", "agents");
  write(join(agents, "alpha", "architect.md"), "---\ndescription: From alpha.\n---\n\nA.\n");
  write(join(agents, "zeta", "architect.md"), "---\ndescription: From zeta.\n---\n\nZ.\n");

  const role = loadRole("architect", root);
  assert.equal(role.description, "From alpha.", "packs are ordered, not filesystem-dependent");
  assert.equal(role.source, join(agents, "alpha", "architect.md"));

  const report = roleSearchReport(root).filter((e) => e.plugin === "pi" && e.exists);
  assert.ok(
    report.some((e) => e.dir === join(agents, "zeta")),
    "the shadowed pack must still show up as somewhere morse looked",
  );
});

// ------------------------------------------------------------------ provenance

test("the search report names every directory, including the ones that are absent", () => {
  const root = project("report");
  write(join(root, ".claude", "agents", "backend.md"), CLAUDE_BACKEND);

  const report = roleSearchReport(root);
  const claudeDir = report.find((e) => e.dir === join(root, ".claude", "agents"));
  assert.ok(claudeDir?.exists, "a directory that exists is reported as such");
  assert.equal(claudeDir.plugin, "claude");

  const morseDir = report.find((e) => e.dir === join(root, ".morse", "roles"));
  assert.ok(morseDir, "morse's own directory is still reported");
  assert.equal(morseDir.exists, false, "a role that did not appear is usually a folder nobody searched");
  assert.equal(morseDir.plugin, undefined);
});

// --------------------------------------------------------------------- opt-out

test("discovery off restores exactly the pre-plugin ladder", () => {
  // Not "finds nothing extra" but "is the same ladder": the assertion has to be
  // that no widened directory exists to be read, not that reading it came back
  // empty this time.
  const root = project("opt-out");
  write(join(root, ".claude", "agents", "backend.md"), CLAUDE_BACKEND);
  assert.ok(loadRole("backend", root), "precondition: it is discoverable when plugins are on");

  process.env.MORSE_PLUGINS = "off";
  try {
    assert.equal(loadRole("backend", root), undefined);
    assert.deepEqual(listRoles(root), []);
    assert.deepEqual(
      roleSearchDirs(root).map((e) => e.dir),
      roleSearchPaths(root),
      "with plugins off the widened ladder is the original ladder",
    );
    assert.ok(roleSearchDirs(root).every((e) => e.plugin === undefined));
  } finally {
    delete process.env.MORSE_PLUGINS;
  }
});

test("every documented spelling of off turns discovery off", () => {
  const root = project("opt-out-spellings");
  write(join(root, ".claude", "agents", "backend.md"), CLAUDE_BACKEND);
  for (const value of ["0", "off", "false", "no", "OFF"]) {
    process.env.MORSE_PLUGINS = value;
    try {
      assert.equal(loadRole("backend", root), undefined, `MORSE_PLUGINS=${value} must disable discovery`);
    } finally {
      delete process.env.MORSE_PLUGINS;
    }
  }
});

test("--no-plugins does not swallow the argument after it", () => {
  // The CLI's argument parser gives any long flag the next non-dash token as
  // its value. --no-plugins is the first boolean long flag that can precede a
  // positional, so `morse join --no-plugins backend` would otherwise parse the
  // agent name as the flag's value and report that no agent was given.
  const root = project("flag-order");
  const cli = fileURLToPath(new URL("../packages/morse-ai/dist/cli.js", import.meta.url));
  const run = (...argv) =>
    execFileSync(process.execPath, [cli, ...argv], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MORSE_HOME: join(tmp, "no-such-home"), HOME: join(tmp, "no-such-user") },
    });

  assert.match(run("prompt", "--no-plugins", "backend"), /\*\*backend\*\*/, "the positional survives");
  assert.match(run("prompt", "backend", "--no-plugins"), /\*\*backend\*\*/, "and order does not matter");
});

// ------------------------------------------------ a fourth ecosystem is a file

test("a new ecosystem is a manifest, with no change to discovery internals", () => {
  // The extensibility claim, tested rather than asserted. Nothing about `acme`
  // is known to morse's source.
  const root = project("user-manifest");
  write(
    join(root, ".morse", "plugins", "acme.json"),
    JSON.stringify({ id: "acme", project: [".acme/agents"], map: { description: "summary" } }),
  );
  write(join(root, ".acme", "agents", "sre.md"), "---\nsummary: Keeps it running.\n---\n\nPage me.\n");

  const role = loadRole("sre", root);
  assert.ok(role, "a manifest on disk is enough to teach morse a new folder");
  assert.equal(role.plugin, "acme");
  assert.equal(role.description, "Keeps it running.", "the manifest's field mapping is what is used");
});

test("a manifest may correct a built-in rather than waiting for a release", () => {
  const root = project("override-builtin");
  write(
    join(root, ".morse", "plugins", "claude.json"),
    JSON.stringify({ id: "claude", project: [".claude/subagents"] }),
  );
  write(join(root, ".claude", "subagents", "backend.md"), CLAUDE_BACKEND);
  write(join(root, ".claude", "agents", "wrong.md"), CLAUDE_BACKEND);

  assert.ok(loadRole("backend", root), "the replaced location is searched");
  assert.equal(loadRole("wrong", root), undefined, "and the built-in location is not");
});

// --------------------------------------------------------- bad input is normal

test("a malformed manifest is skipped, not fatal", () => {
  const root = project("bad-manifest");
  write(join(root, ".morse", "plugins", "broken.json"), "{ this is not json");
  write(join(root, ".morse", "plugins", "nameless.json"), JSON.stringify({ project: [".x"] }));
  write(join(root, ".claude", "agents", "backend.md"), CLAUDE_BACKEND);

  assert.doesNotThrow(() => listRoles(root));
  assert.ok(loadRole("backend", root), "one bad manifest must not disable the good ones");
});

test("a manifest cannot point outside the search root", () => {
  // Containment a level up: the directory a manifest contributes is joined onto
  // a root, so it must obey the same rule a role name does.
  const root = project("manifest-escape");
  write(
    join(root, ".morse", "plugins", "escape.json"),
    JSON.stringify({ id: "escape", project: ["../../../../etc"] }),
  );
  write(
    join(root, ".morse", "plugins", "absolute.json"),
    JSON.stringify({ id: "absolute", project: ["/etc"] }),
  );

  const dirs = roleSearchDirs(root);
  assert.ok(!dirs.some((e) => e.plugin === "escape"), "a relative escape is refused");
  assert.ok(!dirs.some((e) => e.plugin === "absolute"), "an absolute path is refused");
});

test("an empty, unparseable, or non-file entry in a plugin folder is skipped", () => {
  const root = project("bad-entries");
  const agents = join(root, ".claude", "agents");
  write(join(agents, "empty.md"), "");
  // A directory whose name ends in .md: readdir offers it, reading it throws.
  mkdirSync(join(agents, "notafile.md"), { recursive: true });
  write(join(agents, "good.md"), CLAUDE_BACKEND);

  const names = listRoles(root).map((r) => r.name);
  // `good.md` declares `name: backend`, so frontmatter wins over the filename.
  assert.ok(names.includes("backend"), "the good file still loads");
  assert.ok(!names.includes("notafile"), "a directory is not a role definition");
  assert.ok(names.includes("empty"), "an empty file is a nameless role, not a crash");
  assert.equal(loadRole("notafile", root), undefined);
});

test("a missing plugin folder is the normal case, not an error", () => {
  const root = project("nothing-here");
  assert.doesNotThrow(() => listRoles(root));
  assert.deepEqual(listRoles(root), []);
  assert.equal(loadRole("backend", root), undefined);
  assert.ok(
    roleSearchReport(root).some((e) => e.plugin === "claude" && !e.exists),
    "and it is reported as somewhere morse looked and found nothing",
  );
});

// ----------------------------------------------------------------- containment

test("a role name cannot climb out of a plugin directory", () => {
  const root = project("name-escape");
  write(join(root, "secret.md"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  write(join(root, ".claude", "agents", "keep.md"), CLAUDE_BACKEND);

  for (const name of ["../secret", "../../etc/passwd", "..", "/etc/hosts"]) {
    assert.equal(loadRole(name, root), undefined, `${name} must not resolve to a file`);
  }
});
