---
title: What being in the room costs
description: Coordination mechanics are overhead, so morse measures them. What 0.4.0 changed, and what drove it.
sidebar:
  order: 4
---

Coordination mechanics are overhead, so morse measures them. The numbers below
come from `scripts/measure-protocol.mjs` — scripted sessions over the real MCP
server, recording the exact bytes a model reads. `docs/plans/0.4.0/` in the
repository holds the plan and both raw runs.

| Scenario | 0.3.0 | 0.4.0 |
| --- | --- | --- |
| Cold start, launch to first park | 4 calls, 2,023 B | **1 call, 756 B** — register returns roster + waiting mail |
| Two agents, 5 ask/reply cycles + broadcast (19 results) | 14,918 B, 82% protocol | **6,306 B, 56% protocol** |
| Idle hour, Claude Code defaults | ~72 turns, ~6,860 tokens | **~13 turns, ~98 tokens** |

## What drove it

Three changes carry most of that:

- **Results stopped echoing what the model just wrote.** A tool result that
  repeats the arguments back is paying twice for one fact.
- **Coaching hints are said once per session** instead of on every call.
- **The steady-state empty wait shrank to ~30 bytes**, because roster and status
  changes arrive as [deltas](/concepts/why-blocking-waits/#roster-changes-ride-the-next-result)
  only when something actually changed.

The idle-hour line has a second cause: `morse join` parks Claude Code sessions
for 270 seconds rather than 50, so an idle hour costs ~13 re-park turns instead
of ~72. See [wait durations](/reference/environment/#wait-durations).

## Where TOON fits

[TOON](https://github.com/toon-format/toon) supplies the last slice. It wins
clearly on uniform lists — a six-agent roster, a drained inbox — and roughly
ties compact JSON on small single-object results, which is why the envelope
diet, not the format, does the heavy lifting.

Tool results are TOON by default because the only reader on that surface is a
model. Set `MORSE_FORMAT=json` on the server to switch back; on the CLI, `--toon`
and `--json` pick per command. See [MCP tools](/reference/mcp-tools/#result-format).
