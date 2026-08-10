import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Outside the checkout on purpose: gitRoot() shells out from the fixture's cwd,
// so a fixture inside this repo would pick up the repo's own rung.
const tmp = mkdtempSync(join(tmpdir(), "morse-containment-"));
process.env.MORSE_DB = join(tmp, "containment.db");
// Every ambient root the ladder can reach is pinned at a path that does not
// exist. Discovery reads the cwd, the git root and $HOME once plugins land, and
// a test that reads the developer's real ~/.claude/agents is a flake waiting
// for the first maintainer who has one.
process.env.MORSE_ROLES = join(tmp, "no-such-pack");
process.env.MORSE_HOME = join(tmp, "no-such-home");
process.env.HOME = join(tmp, "no-such-user");

const { loadRole, listRoles, isInside, resetDb } = await import("../packages/morse-ai/dist/index.js");

after(() => {
  resetDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** A repo with a roles dir, plus a secret sitting outside it. */
function fixture(name) {
  const root = join(tmp, name);
  const roles = join(root, ".morse", "roles");
  mkdirSync(roles, { recursive: true });
  const secret = join(root, "id_rsa");
  writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE_KEY\n");
  return { root, roles, secret };
}

test("a symlinked role file cannot read outside the roles directory", () => {
  // isInside() resolves lexically, so `..` is caught but a symlink is not. The
  // body of a role file becomes an agent's system prompt, so this is credential
  // exfiltration, not just a stray file read: an attacker commits the symlink,
  // the victim clones the repo, and `morse join backend` does the rest. Git
  // stores symlinks (mode 120000) and restores them on clone, so the whole
  // chain needs nothing but a `git clone`.
  const { root, roles, secret } = fixture("symlink-escape");
  symlinkSync(secret, join(roles, "backend.md"));

  const role = loadRole("backend", root);
  assert.equal(role, undefined, "a role file resolving outside its directory must not load");
});

test("morse roles does not render a definition that escaped by symlink", () => {
  // listRoles() readdirs and reads every .md with no containment check at all,
  // so the exfiltrated body reaches the terminal even when nobody joined it.
  const { root, roles, secret } = fixture("symlink-escape-list");
  symlinkSync(secret, join(roles, "backend.md"));

  const names = listRoles(root).map((r) => r.name);
  assert.ok(!names.includes("backend"), `escaped definition was listed: ${names.join(", ")}`);
});

test("a symlink pointing inside the roles directory still works", () => {
  // The fix must be containment, not a blanket ban on symlinks — a roles dir
  // that is itself a symlink, or a pack shared by symlink, is legitimate.
  const { root, roles } = fixture("symlink-inside");
  writeFileSync(join(roles, "real.md"), "---\nrole: Backend Engineer\n---\n\nGuidance.\n");
  symlinkSync(join(roles, "real.md"), join(roles, "alias.md"));

  const role = loadRole("alias", root);
  assert.ok(role, "a symlink that stays inside the directory is legitimate");
  assert.equal(role.role, "Backend Engineer");
});

test("a dangling symlink is skipped, not fatal", () => {
  // Whatever resolves the real path throws ENOENT here. A missing file is
  // normal; it must not take down `morse join` or `morse roles`.
  const { root, roles } = fixture("dangling");
  symlinkSync(join(roles, "does-not-exist.md"), join(roles, "backend.md"));

  assert.equal(loadRole("backend", root), undefined);
  assert.doesNotThrow(() => listRoles(root), "a dangling symlink must not be fatal");
});

test("containment holds against an absolute symlink out of the tree", () => {
  const { root, roles } = fixture("absolute-escape");
  symlinkSync("/etc/hosts", join(roles, "backend.md"));

  assert.equal(loadRole("backend", root), undefined);
  assert.ok(!listRoles(root).some((r) => r.name === "backend"));
});

test("isInside is not satisfied by a lexical prefix match", () => {
  // "/a/broles" starts with "/a/b" as a string but is a different directory.
  assert.equal(isInside("/a/b", "/a/broles/x.md"), false);
  assert.equal(isInside("/a/b", "/a/b/x.md"), true);
  assert.equal(isInside("/a/b", "/a/b/../c"), false);
});
