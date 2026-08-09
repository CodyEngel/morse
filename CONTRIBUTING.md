# Contributing

Morse is a small project maintained by one person. Issues and pull requests are welcome; please open an issue before a large change so we can agree on the shape of it first.

Security issues go through [SECURITY.md](SECURITY.md), not the public tracker.

## Getting set up

```bash
npm install     # `prepare` builds dist/ automatically
npm test        # builds, then runs the full suite
npm run dev     # tsc --watch
```

Node 22.5 or newer. That floor is not arbitrary — morse uses the built-in `node:sqlite`, which does not exist before it.

## Architecture

Roughly in dependency order:

| File | Responsibility |
| --- | --- |
| `src/db.ts` | SQLite handle, schema, migrations, file permissions |
| `src/store.ts` | All data access. Delivery, cursors, presence |
| `src/wait.ts` | The blocking primitives: `waitForInbox`, `waitForReply` |
| `src/mcp/rpc.ts` | Minimal MCP stdio transport (JSON-RPC over stdin/stdout) |
| `src/mcp/tools.ts` | Tool schemas and descriptions |
| `src/mcp/server.ts` | Tool handlers. Knows nothing about roles |
| `src/roles.ts` | The role-file contract: lookup, parsing, validation |
| `src/prompt.ts` | The protocol prompt handed to a joined agent |
| `src/cli/` | Human-facing commands and terminal rendering |

Two rules keep the layers honest:

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

```bash
npm test
npm version <patch|minor|major>   # tags the commit
git push --follow-tags            # the tag triggers .github/workflows/release.yml
```

The release workflow publishes with provenance and refuses to run if the tag
disagrees with `package.json`. It needs an `NPM_TOKEN` repository secret.

Publishing by hand works too, just without provenance — npm can only attest to
a build it can identify, and a laptop has no OIDC provider:

```bash
npm publish
```

`prepare` builds before publish. `npm pack --dry-run` should show only `dist/`, `README.md`, `LICENSE`, and `package.json`.

The package is published as `morse-ai` because `morse` was already taken. The installed command is still `morse`, and nothing else — env vars, `~/.morse/`, room names — uses the package name.
