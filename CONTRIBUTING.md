# Contributing

Morse is a small project maintained by one person. Issues and pull requests are welcome; please open an issue before a large change so we can agree on the shape of it first.

Security issues go through [SECURITY.md](SECURITY.md), not the public tracker.

## Getting set up

```bash
npm install     # `prepare` builds dist/ automatically
npm test        # builds, then runs the full suite
npm run dev     # tsc --watch
```

Node 22.13 or newer. That floor is not arbitrary — morse uses the built-in `node:sqlite`, which exists from 22.5 but stays behind `--experimental-sqlite` until 22.13.

## Architecture

Three packages in one workspace. `packages/morse-ai` is the product; the other
two are libraries under it, and **neither depends on the other**.

| Package | Responsibility |
| --- | --- |
| `packages/bus` | `db.ts` SQLite handle, schema, permissions · `bus.ts` messages, delivery, cursors · `wait.ts` the blocking primitives · `registry.ts` **the four-method port** · `mcp.ts` its five tools · `cli.ts` `morse-bus` |
| `packages/registry` | `registry.ts` file-backed agent records, presence, status · `roles.ts` / `plugins.ts` / `toml.ts` the role-file contract · `room.ts` room naming and sanitising · `mcp.ts` its two tools · `cli.ts` `morse-registry` |
| `packages/morse-ai` | `morse.ts` composition and the 0.2 import · `mcp/server.ts` the composed server and its three tools · `prompt.ts` the protocol prompt · `cli/` the `morse` command |

Four rules keep the layers honest:

**Only the message log gets a database.** Every agent record has exactly one
writer — its own process — so the registry is files. `@morse-ai/registry` must
never import `node:sqlite`; CI fails if it does. The log needs SQLite for total
order, not for concurrency: `inbox` is `id > cursor`, and that ordering has to
hold across independent processes.

**The bus talks to a registry through an interface it declares itself.** Four
methods, no more. If you find yourself wanting a fifth, the operation probably
belongs in `morse-ai`, where both halves are in scope — that is why
`morse_register`, `morse_ask` and `morse_wait` live there. The suite runs the
bus against a stub carrying exactly those four keys, and CI installs each
sub-package alone to prove the independence rather than assert it.


**The bus stays policy-free.** Morse ships no roles and the MCP server has no concept of one — `morse join` resolves a role file and passes the result through the environment. Anything opinionated about what an agent *is* belongs in a role file or a separate package.

**Escaping happens at the boundary.** The store keeps exactly what an agent wrote. `src/cli/format.ts` escapes control characters on the way to a terminal. Do not move that into the store, and do not print agent-authored text without it.

## Dependencies

Morse has zero runtime dependencies and should keep it that way. It is a coordination tool people install globally; a dependency here is a dependency in everyone's agent setup. TypeScript and `@types/node` are the only dev dependencies.

If something seems to need a library, check whether the standard library covers it — the MCP transport and the frontmatter parser are both deliberate small implementations rather than dependencies.

## Tests

`node:test`, no framework. The suite covers four levels:

- `test/store.test.js` — delivery semantics against the store directly
- `test/roles.test.js` — the role-file contract
- `test/security.test.js` — escaping, path traversal, file permissions
- `test/mcp.test.js` — the MCP server over real stdio, as a harness drives it
- `test/six-agents.test.js` — six independent processes coordinating

Bug fixes should come with a test that fails without them. Concurrency bugs in particular have been the recurring theme here — the cold-start test runs three rounds precisely because the bug it guards only appeared some of the time.

Prefer tests that explain the failure they prevent. A comment saying why a case matters is worth more than the assertion count.

## Style

Match the surrounding code. Comments explain *why* something is the way it is, especially where the reason is non-obvious — most of the tricky parts of morse exist because agent harnesses are turn-based, and that is rarely self-evident from the code alone.

## Releasing

Maintainer only:

Versions are **lockstep**: all three packages always carry the same number and
always publish together, even when a release touches only one of them.
`morse-ai` pins the other two exactly, so a published `morse-ai` can only
resolve versions it was tested against.

```bash
npm test
npm version <patch|minor|major> --workspaces --include-workspace-root
git commit -am "Release vX.Y.Z" && git tag vX.Y.Z
git push --follow-tags            # the tag triggers .github/workflows/release.yml
```

Bump `morse-ai`'s two `dependencies` entries to the same number in the same
commit. The release workflow checks every package against the tag *and* checks
those pins, and refuses to publish if any of them disagree — so a missed bump
is a red build rather than a broken install.

`version.ts` reads from each package's own `package.json`, so there is nothing
else to bump.

Publishing order is bus and registry first, then `morse-ai`, and it is
irreversible: npm burns a version permanently even after an unpublish, so if the
last publish fails the recovery is a patch bump of all three rather than a retry.

If commits are signed through an agent that `npm version` cannot reach — 1Password's,
for instance — its internal `git commit` fails. `git -c` does not help, because npm
runs git as a subprocess; the config has to arrive through the environment:

```bash
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0=gpg.ssh.program GIT_CONFIG_VALUE_0=/usr/bin/ssh-keygen
export GIT_CONFIG_KEY_1=user.signingkey GIT_CONFIG_VALUE_1=~/.ssh/<signing-key>
export GIT_CONFIG_KEY_2=commit.gpgsign  GIT_CONFIG_VALUE_2=true
```

The release workflow publishes with provenance and refuses to run if the tag
disagrees with `package.json`.

It authenticates by OIDC, not a secret: npm is configured to trust this
repository's `release.yml` as a publisher, so there is no token in the repo to
leak or rotate. If that trust is ever removed, add an `NPM_TOKEN` secret and
restore the `NODE_AUTH_TOKEN` env block noted in the workflow.

Publishing by hand works too, just without provenance — npm can only attest to
a build it can identify, and a laptop has no OIDC provider:

```bash
npm publish
```

`prepare` builds before publish. `npm pack --dry-run` should show only `dist/`, `README.md`, `LICENSE`, and `package.json`.

The package is published as `morse-ai` because `morse` was already taken. The installed command is still `morse`, and nothing else — env vars, `~/.morse/`, room names — uses the package name.
