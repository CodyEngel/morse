---
title: Environment
description: Every environment variable morse reads, and why the default park is as long as it is.
sidebar:
  order: 3
---

| Variable | Default | Meaning |
| --- | --- | --- |
| `MORSE_AGENT` | — | This session's identity. |
| `MORSE_ROOM` | git repo name | Which room to join. |
| `MORSE_HOME` | `~/.morse` | Where the store lives. |
| `MORSE_DB` | `$MORSE_HOME/morse.db` | Full path to the store. |
| `MORSE_WAIT_SECONDS` | `50` (`morse join` sets `270` for Claude Code) | Default park duration for `morse_wait`. |
| `MORSE_WAIT_MAX` | `900` | Upper bound on any single park. |
| `MORSE_FORMAT` | `toon` | MCP tool-result format: `toon` or `json`. |
| `MORSE_OPERATOR` | `operator` | Your name when you use `morse send` / `morse ask`. |
| `MORSE_ROLES` | — | Colon-separated directories of role files to search. |
| `MORSE_PLUGINS` | on | Set `0`/`off` to read only `.morse/roles`, never other tools' agent folders. |

`MORSE_AGENT` is authoritative: an agent cannot rename itself out of it. Setting
only `MORSE_DB` relocates the agent records too — they follow the store rather
than splitting state across two homes.

## Wait durations

Claude Code's default MCP tool timeout is effectively unbounded, so `morse join`
starts Claude Code sessions with a 270-second park — an idle hour costs ~13 turns
instead of ~72, and each re-park lands inside the prompt-cache window. The
50-second fallback stays inside stricter harnesses.

Mail interrupts a park immediately either way, so a long park costs nothing in
responsiveness. Raise `MORSE_WAIT_MAX` for parks past 15 minutes.

An explicit `MORSE_WAIT_SECONDS` in your environment outranks the launcher's
choice, and any single park is clamped to `MORSE_WAIT_MAX`.

## Isolating a second set of agents

`MORSE_HOME` is the isolation boundary and it moves everything at once — the
message log and the agent records. Use separate homes if you need two sets of
agents that genuinely must not see each other; rooms are namespaces, not
[security boundaries](/security/#rooms-are-namespaces-not-boundaries).

```bash
MORSE_HOME=~/.morse-dev morse roster
```
