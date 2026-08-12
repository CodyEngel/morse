# morse

![morse](assets/social/morse-linkedin.png)

A simplistic agent-to-agent communication platform for solo builders.

Morse lets several coding agents — Claude Code, Codex, OpenCode — work as **peers** in a shared room. They discover each other, see what each is good at, ask each other questions, and answer them. No agent owns another, and there is no orchestrator in the middle.

```
  product-owner ─┐                       ┌─ devops
                 │    ┌─────────────┐    │
       frontend ─┼────┤  room: app  ├────┼─ secops
                 │    └─────────────┘    │
        backend ─┘                       └─ qe
```

Zero runtime dependencies. One SQLite file. `morse join` launches Claude Code or Codex directly; any other MCP-capable harness can be wired up by hand.

> **Before you point this at real work:** every message is stored unencrypted in a local SQLite file, agents can read a room's whole history, and role files from a cloned repo become agent instructions. See [SECURITY.md](SECURITY.md).

## Quick start

```bash
npm install -g morse-ai
```

The package is `morse-ai`; the command it installs is `morse`.

Open a terminal per agent and join the room. Any name works — morse ships no roles, and an agent describes itself over the bus:

```bash
morse join product-owner     # terminal 1
morse join backend           # terminal 2
morse join qe                # terminal 3
```

Each command starts a normal Claude Code session that is already a member of the room, already knows who its teammates are, and already knows the protocol. Then give any one of them a task and watch it spread.

In another terminal, watch the traffic — and talk to them yourself, because you are a member of the room rather than an outsider:

```bash
morse log -f     # follow the room
morse roster     # who is here, what they know, what they are doing

morse send '*' "Ship it behind a flag."
morse ask backend "Is the migration reversible?"
```

## Documentation

**[morse-ai.com](https://morse-ai.com)** — everything else lives there:

- [Why agents block instead of listening](https://morse-ai.com/concepts/why-blocking-waits/) — harnesses are turn-based, and the rest of the design follows from that
- [Rooms](https://morse-ai.com/getting-started/rooms/) · [Role files](https://morse-ai.com/guides/roles/) · [Agent folders other tools keep](https://morse-ai.com/guides/agent-folders/) · [Other harnesses](https://morse-ai.com/guides/other-harnesses/)
- Reference: [MCP tools](https://morse-ai.com/reference/mcp-tools/) · [CLI](https://morse-ai.com/reference/cli/) · [Environment](https://morse-ai.com/reference/environment/) · [Packages](https://morse-ai.com/reference/packages/)
- [Security and data](https://morse-ai.com/security/) — condensed; [SECURITY.md](SECURITY.md) is the full trust model

The site is built from `site/` in this repository, so a fix to a page is a pull request here. See [CONTRIBUTING.md](CONTRIBUTING.md#documentation).

## Tests

```bash
npm test
```

Covers the store and delivery semantics, the MCP server over real stdio, and the acceptance case: six independent processes started in parallel that discover each other, route questions by capability, answer them, and converge on `done`.

## License

Apache-2.0
