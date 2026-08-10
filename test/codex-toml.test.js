import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../packages/morse-ai/dist/cli.js", import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "morse-codex-")));
process.env.MORSE_DB = join(tmp, "codex.db");
process.env.MORSE_ROLES = join(tmp, "no-such-pack");
process.env.MORSE_HOME = join(tmp, "no-such-home");
process.env.HOME = join(tmp, "no-such-user");

const { loadRole, listRoles, resetDb } = await import("../packages/morse-ai/dist/index.js");

after(() => {
  resetDb();
  rmSync(tmp, { recursive: true, force: true });
});

function codexRepo(name, files) {
  const root = join(tmp, name);
  const agents = join(root, ".codex", "agents");
  mkdirSync(agents, { recursive: true });
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(agents, file), contents);
  return root;
}

function roles(root) {
  return execFileSync(process.execPath, [CLI, "roles"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
  });
}

// The case a naive line-oriented `key = "value"` reader passes by accident: it
// takes the value as the literal `"""` and drops the prompt text as unparseable
// lines. You get a plausible-looking role with a silently truncated system
// prompt — no exception, no warning. So assert on the CONTENT of the brief,
// not merely that a role was found.
test("a multi-line developer_instructions lands in brief in full", () => {
  const root = codexRepo("multiline", {
    "backend.toml": `name = "backend"
description = "Owns APIs and data modelling."
developer_instructions = """
You own the API layer.
Route UI questions to the frontend engineer.
"""
`,
  });

  const role = loadRole("backend", root);
  assert.ok(role, "expected .codex/agents/backend.toml to be discovered");
  assert.equal(role.description, "Owns APIs and data modelling.");
  assert.match(role.brief ?? "", /You own the API layer\./);
  assert.match(
    role.brief ?? "",
    /Route UI questions to the frontend engineer\./,
    "the second line was dropped — the reader stopped at the first newline",
  );
  assert.ok(!(role.brief ?? "").includes('"""'), "the delimiter must not survive into the prompt");
});

// The same rule the markdown plugins follow, extended to TOML: agents route
// work by reading `skills`, so a tool allowlist or a sandbox setting appearing
// there sends work to the wrong teammate.
test("no TOML field reaches skills", () => {
  const root = codexRepo("no-skills", {
    "backend.toml": `name = "backend"
description = "Owns APIs."
sandbox_mode = "workspace-write"
developer_instructions = "Guidance."
`,
  });

  const role = loadRole("backend", root);
  assert.deepEqual(role.skills, [], "borrowed roles land with empty skills, by design");
});

// "Refuse, never guess" — a half-read prompt is strictly worse than no role,
// because the user cannot see that anything went wrong.
test("a TOML construct outside the supported subset is refused, not half-parsed", () => {
  const root = codexRepo("out-of-subset", {
    "tabled.toml": `name = "tabled"
description = "Uses a table."

[tools]
allowed = ["read", "write"]
`,
  });

  assert.equal(loadRole("tabled", root), undefined, "an out-of-subset file must not load");
  const names = listRoles(root).map((r) => r.name);
  assert.ok(!names.includes("tabled"), "a refused file must not appear as a definition");
});

test("a refused TOML file does not appear in morse roles as a definition", () => {
  // Specifically not "didn't crash": silent partial success is the failure mode.
  // It may be reported as a rejection — it must not be listed as a role.
  const root = codexRepo("refused-listing", {
    "arrayed.toml": `name = "arrayed"
description = "Uses an array of tables."

[[agents]]
name = "nested"
`,
  });

  const out = roles(root);
  assert.ok(
    !/^arrayed\s/m.test(out),
    `a refused file was listed as a usable definition:\n${out}`,
  );
});
