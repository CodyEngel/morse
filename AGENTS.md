# Working on morse

Instructions for any agent — Claude Code, Codex, or otherwise — making changes
in this repository. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md) first;
it covers setup, architecture and the four rules that keep the layers honest.
Everything here is in addition to that.

## The docs site is part of the change, not a follow-up

The reference documentation lives in `site/` and is published to
[morse-ai.com](https://morse-ai.com). The README no longer repeats it — it links
to it. That makes drift invisible in a way it was not before: a change to a
command, a tool, an environment variable or the role contract that does not land
on the matching page leaves a page that quietly starts lying, and a reader has
no way to tell which of the two is current.

**So: if your change alters something the site describes, update the page in the
same commit.** Not a follow-up issue, not a TODO — the same commit, because the
next agent to touch this repository will read the docs as ground truth.

| If you change… | Update |
| --- | --- |
| `packages/morse-ai/src/cli/main.ts` — commands, flags, help text | `site/src/content/docs/reference/cli.md` |
| `packages/morse-ai/src/cli/agent.ts` — agent verbs, exit codes | `site/src/content/docs/reference/cli.md` |
| Any MCP tool definition (`morse-ai/src/mcp/tools.ts`, `bus/src/mcp.ts`, `registry/src/mcp.ts`) | `site/src/content/docs/reference/mcp-tools.md` |
| Anything reading a `MORSE_*` environment variable, or its default | `site/src/content/docs/reference/environment.md` |
| `packages/registry/src/roles.ts`, `toml.ts` — the role-file contract or lookup ladder | `site/src/content/docs/guides/roles.md`, `guides/agent-folders.md` |
| `packages/registry/src/plugins.ts` — manifest fields, built-in plugins | `site/src/content/docs/guides/agent-folders.md` |
| `buildHarnessArgs` — how a harness is launched or wired | `site/src/content/docs/guides/other-harnesses.md` |
| The package split or the four-method registry port | `site/src/content/docs/reference/packages.md` |
| Presence, status or convergence semantics | `site/src/content/docs/concepts/convergence.md` |
| `wait.ts`, `morse_ask` / `morse_wait` behaviour, `prompt.ts` | `site/src/content/docs/concepts/why-blocking-waits.md` |
| Protocol-cost measurements (`scripts/measure-protocol.mjs`, `docs/plans/`) | `site/src/content/docs/concepts/protocol-cost.md` |
| `SECURITY.md` | `site/src/content/docs/security.md` |
| The quick start in `README.md` | `site/src/content/docs/getting-started/quick-start.md` |

`.github/workflows/docs.yml` enforces this on pull requests: a PR that touches
one of those surfaces without touching `site/src/content/docs/` fails, and says
so. If the change genuinely is not described anywhere on the site — an internal
refactor, a test, a comment — put `docs: n/a` in the PR body and the check
passes. Use that when it is true; do not use it to defer the work.

## Working on the site

```bash
npm run docs:dev      # local preview at http://localhost:4321
npm run docs:build    # production build, and the internal link check
```

Deployment is not yours to run. Cloudflare Workers Builds is connected to this
repository and deploys on push; `npm run docs:deploy` exists as a maintainer's
break-glass and needs `wrangler login`. `.github/workflows/docs.yml` therefore
builds and checks, and never deploys — see
[CONTRIBUTING.md](CONTRIBUTING.md#deploys) before changing that.

The scripts install `site/`'s dependencies first, so they work from a fresh
clone. `site/` is a standalone npm project, deliberately outside the workspace
`packages/*` glob: it is not published, and a docs dependency must never be able
to reach the packages that are.

Five things to keep true:

- **Only `astro` and `@astrojs/starlight`.** No UI framework, no CSS framework,
  no component library. The site is prose; adding a dependency to render prose
  is how a docs site becomes a second project to maintain.
- **The sidebar is explicit.** A new page is invisible until it is added to the
  `sidebar` array in `site/astro.config.mjs`. That is deliberate — reading order
  is an argument, and a directory listing cannot express one.
- **Internal links are site-absolute with a trailing slash**
  (`/reference/cli/`, `/security/#role-files-are-executable-instructions`).
  `npm run docs:build` fails on a link that resolves to nothing, anchors
  included, so renaming a heading is caught rather than shipped.
- **Do not move detail back into the README.** It keeps the banner, the
  description, the diagram, the quick start, the security warning and the links.
  Anything longer belongs on a page.
- **Do not invent behaviour.** Every page is derived from the README, from
  `SECURITY.md`, or from the source. If you are unsure what something does,
  leave an `<!-- TODO -->` in the page rather than a confident guess — a wrong
  sentence in the reference costs more than a missing one.

## Conventions the rest of the repository already has

- Comments explain *why*, especially where the reason is non-obvious. Most of
  the tricky parts of morse exist because agent harnesses are turn-based, and
  that is rarely self-evident from the code.
- Zero runtime dependencies, and it stays that way.
- Bug fixes come with a test that fails without them.
- `npm test` builds first, then runs the suite. Run it before you claim a change
  works.
