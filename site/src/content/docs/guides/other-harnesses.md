---
title: Other harnesses
description: Launching Codex or any other MCP-capable harness into a room, and wiring one up by hand.
sidebar:
  order: 3
---

The bus is portable — it is a standard MCP stdio server — but no two harnesses
agree on how to be told about a server or how to have instructions injected.
`morse join` handles that difference for you:

```bash
morse join backend                      # Claude Code (default)
morse join backend --harness codex      # Codex
morse join backend --harness <command>  # anything else, Claude Code's flags
```

Anything after `--` is passed through to the harness:

```bash
morse join backend -- --permission-mode plan
```

## Codex

Verified end to end. Codex takes inline TOML config rather than a JSON blob, and
has no system-prompt flag, so the protocol prompt rides in the opening turn
instead of a system prompt.

:::caution[One caveat, and it is Codex's rather than morse's]
`codex exec` auto-denies MCP tool calls, so a non-interactive run needs an
approval policy that permits them.
:::

## Wiring a harness up by hand

It is an ordinary stdio server:

```json
{
  "mcpServers": {
    "morse": {
      "command": "morse",
      "args": ["mcp"],
      "env": { "MORSE_AGENT": "backend", "MORSE_ROOM": "app" }
    }
  }
}
```

`MORSE_AGENT` is the identity, and it is authoritative: an agent cannot rename
itself out of it — passing a different `name` to `morse_register` (or `--as` on
the CLI) is reported and ignored. Everything else is optional.

For a plain `claude` session in a project, `morse init` writes that `.mcp.json`
for you; set your identity in the environment and start the harness normally:

```bash
morse init
MORSE_AGENT=backend claude
```

An agent wired up this way gets the tools but not the protocol prompt. Print it
with `morse prompt <agent>` and feed it to the harness however that harness
accepts system prompts.

## Mixed rooms show who is running what

Morse reads the harness's name from the MCP handshake:

```
$ morse roster
backend      done       Backend Engineer          codex
frontend     working    Frontend Engineer         claude-code
```

## Harnesses that cannot speak MCP

The same ten operations exist as shell verbs, so a harness that can run commands
can still take part — the mechanism is identical, since a Bash tool call is
still a tool call an agent can park inside. `morse join --transport cli` skips
the MCP wiring and hands the agent the CLI form of the protocol instead. See
[the agent verbs](/reference/cli/#agent-verbs).
