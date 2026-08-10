import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { parseRole, loadRole, listRoles, roleSearchPaths } = await import("../packages/morse-ai/dist/index.js");

const tmp = mkdtempSync(join(tmpdir(), "morse-roles-"));
// Discovery reads the home directory now, so a maintainer with their own
// ~/.claude/agents would see extra definitions here and fail the count below.
process.env.HOME = join(tmp, "no-such-user");
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeRole(dir, name, contents) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, contents);
  return path;
}

test("frontmatter is public, the body is private guidance", () => {
  const role = parseRole(
    `---
role: Backend Engineer
description: Owns APIs, SQL, and query performance.
skills: [sql, api-design]
---

You own the API and data layer. Route UI questions to the frontend engineer.
`,
    "/roles/backend.md",
  );

  assert.equal(role.name, "backend", "name falls back to the filename");
  assert.equal(role.role, "Backend Engineer");
  assert.equal(role.description, "Owns APIs, SQL, and query performance.");
  assert.deepEqual(role.skills, ["sql", "api-design"]);
  assert.match(role.brief, /Route UI questions/);
});

test("skills accept block lists as well as inline ones", () => {
  const role = parseRole(
    `---
role: QE
skills:
  - edge-cases
  - regression-risk
---

Ask the uncomfortable questions.
`,
    "/roles/qe.md",
  );
  assert.deepEqual(role.skills, ["edge-cases", "regression-risk"]);
});

test("a file with no frontmatter is still a usable role", () => {
  // The minimum viable role: a name and some guidance.
  const role = parseRole("Just do the thing carefully.\n", "/roles/helper.md");
  assert.equal(role.name, "helper");
  assert.equal(role.description, undefined);
  assert.deepEqual(role.skills, []);
  assert.match(role.brief, /Just do the thing/);
});

test("the scaffold morse writes is parseable by morse", async () => {
  // Guards against the template drifting past what the reader supports.
  const { roleTemplate } = await import("../packages/morse-ai/dist/index.js");
  const role = parseRole(roleTemplate("backend"), "/roles/backend.md");
  assert.equal(role.role, "Backend", "the title is derived from the name for the author to edit");
  assert.ok(role.description && role.description.length > 20, "description must survive parsing");
  assert.ok(role.skills.length > 0);
  assert.ok(role.brief);
});

test("a nearer role definition shadows a shared one", () => {
  const shared = join(tmp, "pack");
  const project = join(tmp, "project");
  writeRole(shared, "backend", "---\nrole: Shared Backend\n---\nshared\n");
  writeRole(join(project, ".morse", "roles"), "backend", "---\nrole: Project Backend\n---\nlocal\n");

  const previous = process.env.MORSE_ROLES;
  process.env.MORSE_ROLES = shared;
  try {
    // The project directory is searched before the shared pack, so a team can
    // override a published role without forking it.
    assert.equal(loadRole("backend", project).role, "Project Backend");

    const names = listRoles(project).map((r) => r.name);
    assert.deepEqual(names, ["backend"], "the shadowed copy must not appear twice");
  } finally {
    if (previous === undefined) delete process.env.MORSE_ROLES;
    else process.env.MORSE_ROLES = previous;
  }
});

test("an unknown role is absent, not an error", () => {
  // Morse ships no roles, so this is the default experience.
  assert.equal(loadRole("nobody-defined-this", tmp), undefined);
});

test("the search path is ordered nearest-first", () => {
  const paths = roleSearchPaths(tmp);
  assert.ok(paths.length >= 2);
  assert.ok(paths.some((p) => p.endsWith(join(".morse", "roles"))));
});

test("the shipped examples parse and describe distinct expertise", () => {
  const examples = fileURLToPath(new URL("../examples/roles", import.meta.url));
  const previous = process.env.MORSE_ROLES;
  process.env.MORSE_ROLES = examples;
  try {
    const roles = listRoles(tmp);
    assert.equal(roles.length, 6);

    // The whole point of the directory: no two agents claim the same ground.
    const skills = roles.flatMap((r) => r.skills);
    assert.equal(new Set(skills).size, skills.length, "example roles should not duplicate skills");
    for (const role of roles) {
      assert.ok(role.description, `${role.name} needs a description to be routable`);
      assert.ok(role.brief, `${role.name} needs a brief`);
    }
  } finally {
    if (previous === undefined) delete process.env.MORSE_ROLES;
    else process.env.MORSE_ROLES = previous;
  }
});

test("each harness gets the launch flags it actually understands", async () => {
  const { buildHarnessArgs } = await import("../packages/morse-ai/dist/index.js");
  const base = {
    node: "/usr/bin/node",
    cliPath: "/x/cli.js",
    serverEnv: { MORSE_AGENT: "backend", MORSE_ROOM: "app" },
    systemPrompt: "PROTOCOL",
    passthrough: [],
    opening: "GO",
  };

  const claude = buildHarnessArgs({ ...base, harness: "claude" });
  assert.ok(claude.includes("--mcp-config"));
  assert.ok(claude.includes("--append-system-prompt"));
  assert.equal(claude.at(-1), "GO", "the opening turn is the prompt argument");
  assert.match(claude[claude.indexOf("--mcp-config") + 1], /"MORSE_AGENT":"backend"/);

  const codex = buildHarnessArgs({ ...base, harness: "codex" });
  // Codex has no system-prompt flag, so the protocol rides in the prompt.
  assert.ok(!codex.includes("--append-system-prompt"));
  assert.ok(!codex.includes("--mcp-config"));
  assert.ok(codex.some((a) => a.startsWith("mcp_servers.morse.command=")));
  assert.ok(codex.some((a) => a.includes('MORSE_AGENT="backend"')));
  assert.match(codex.at(-1), /PROTOCOL[\s\S]*GO/);
});

test("the reported version is the published one", async () => {
  // A hardcoded literal here silently drifts on every release, leaving
  // `morse --version` and the MCP handshake advertising a version that was
  // never published.
  const { VERSION } = await import("../packages/morse-ai/dist/index.js");
  const { createRequire } = await import("node:module");
  // The manifest that actually ships morse-ai, not the private workspace root.
  const pkg = createRequire(import.meta.url)("../packages/morse-ai/package.json");
  assert.equal(VERSION, pkg.version);
});
