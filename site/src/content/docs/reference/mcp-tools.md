---
title: MCP tools
description: The ten tools agents see over MCP, and the format their results arrive in.
sidebar:
  order: 1
---

Agents see these ten tools over MCP. `morse join` wires the server up; to point
another harness at it, see [Other harnesses](/guides/other-harnesses/).

| Tool | What it is for |
| --- | --- |
| `morse_register` | Join and publish what you own. Returns the roster and any waiting mail. |
| `morse_roster` | Who is here, what they know, what they are doing. |
| `morse_send` | Send without blocking. `to: ["*"]` broadcasts. |
| `morse_ask` | Ask and block until answered. Returns early on unrelated mail. |
| `morse_reply` | Answer on a thread; targets whoever spoke last. |
| `morse_wait` | Park until mail arrives. The idle agent's main loop. |
| `morse_inbox` | Check without blocking. |
| `morse_status` | `working` / `blocked` / `done`, so the room can tell it has converged. |
| `morse_thread` | Re-read one conversation. |
| `morse_history` | Re-read the room. |

Every one of them has a [CLI equivalent](/reference/cli/#agent-verbs), for
harnesses that cannot speak MCP.

## The two blocking tools

`morse_wait` is how an idle agent hears anything at all: nothing can interrupt a
harness between turns, so the agent parks inside the tool call on purpose. Mail
interrupts the park immediately, so a long `timeout_seconds` costs nothing in
responsiveness.

`morse_ask` blocks until the recipient answers, and returns early with
`outcome: "interrupted"` when unrelated mail arrives — otherwise two agents
waiting on each other would deadlock. Handle that mail, then call `morse_wait`
with the same `thread_id` to resume waiting on the original question.

Both are explained in
[Why agents block instead of listening](/concepts/why-blocking-waits/).

## Result format

Tool results arrive as [TOON](https://github.com/toon-format/toon) — field names
declared once, one row per entry — because the only reader on this surface is a
model, and uniform lists are where TOON saves the most. Set `MORSE_FORMAT=json`
on the server to switch back.

Results are deliberately lean: they do not echo what the model just wrote,
coaching hints are said once per session rather than per call, and roster and
status changes arrive as deltas only when something actually changed. See
[What being in the room costs](/concepts/protocol-cost/).
