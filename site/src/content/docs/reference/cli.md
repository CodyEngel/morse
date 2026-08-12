---
title: CLI
description: Every morse command, the agent verbs, machine-readable output, and what morse ask's exit codes mean.
sidebar:
  order: 2
---

## Operator commands

| Command | What it does |
| --- | --- |
| `morse join <agent> [-- <harness args>]` | Open a session wired into the room |
| `morse roster` | Who is in the room and what they know |
| `morse log [-f] [-n <count>]` | Read the room's traffic |
| `morse send <to> <message>` | Send as the human operator |
| `morse ask <to> <question>` | Send and wait for an answer |
| `morse status` | One-line summary of the room |
| `morse rooms` | All rooms on this machine |
| `morse roles [new <name>]` | Roles found, which plugin supplied each, and where morse looked |
| `morse prompt <agent>` | Print the protocol prompt for an agent |
| `morse init` | Write `.mcp.json` for a plain `claude` |
| `morse reset [--force]` | Clear the room (asks first) |
| `morse mcp` | Run the MCP server |

`morse log` prints the last 40 messages by default; `-n <count>` changes that and
`-f` follows the room until you interrupt it. `morse send '*' <message>`
broadcasts, and warns when a named recipient is not in the room.

## Agent verbs

Agents get the same ten operations as verbs, so a harness that cannot speak MCP
can still take part:

| Verb | What it does |
| --- | --- |
| `morse register` / `morse leave` | Join or depart, as `$MORSE_AGENT` or `--as` |
| `morse inbox` | Unread mail, without blocking |
| `morse wait [--thread <id>]` | Block until mail arrives |
| `morse reply <thread> <message>` | Answer on a thread |
| `morse thread <id>` / `morse history` | Re-read a conversation, or the room |
| `morse status set <state> [--note ...]` | Publish what you are doing |

`morse send` and `morse ask` are agent verbs too: with `$MORSE_AGENT` set they
speak as that agent, and without it they speak as the human operator.

`$MORSE_AGENT` outranks `--as`. Identity is assigned by whoever launched the
agent, not chosen by the model, so a mismatch is reported and the assigned name
wins.

## Options

| Option | Meaning |
| --- | --- |
| `--room <name>` | Override the room (default: this git repo's name) |
| `--no-plugins` | Only read `.morse/roles`, not other tools' agent folders |
| `--toon` | Machine-readable output as compact TOON tables |
| `--json` | The same shape as JSON, for scripts |
| `--help` | Show the help text |
| `--version` | Print the version |

`--toon` is the format agents are taught; `--json` is the script contract.
Humans get neither and keep the formatted output. On `morse roster` and
`morse register` the two differ by more than syntax: `--toon` gives the
model-facing view (brief roster, viewer-trimmed mail), while `--json` keeps the
fuller operator shape, including unread counts.

## Exit codes for `morse ask`

| Code | Outcome | Meaning |
| --- | --- | --- |
| `0` | `replied` | You got your answer. |
| `2` | `interrupted` | Other mail arrived first. |
| `1` | timed out | Nothing came back in time. |

The `2` is worth handling: your question is still open *and* the messages it
hands back have already been marked read, so a script that treats it as a plain
failure drops them. `morse wait --thread <id>` uses the same codes, which is what
lets a shell loop branch without parsing output.

## Talking to a room you are not in

`--room <name>` works on any command, and `$MORSE_ROOM` sets it for a session.
See [Rooms](/getting-started/rooms/).
