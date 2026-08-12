# Claude Code in this repository

The instructions live in [AGENTS.md](AGENTS.md), so every harness reads the same
ones. Read it before making changes.

The rule most often missed: the reference documentation is the site in `site/`,
published to [morse-ai.com](https://morse-ai.com). If your change alters
something a page describes — a command, an MCP tool, an environment variable,
the role contract — update that page in the same commit. AGENTS.md has the
surface-to-page table, and CI fails a pull request that skips it.

Then [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture, and the rules
that keep the three packages independent.
