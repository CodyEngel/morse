---
title: Rooms
description: How morse keeps one project's agents from hearing another's, and where that state lives.
sidebar:
  order: 2
---

A room is the set of agents that can hear each other. State is machine-wide
under `~/.morse`, and rooms keep projects apart.

## The room defaults to your project

The room name defaults to your git repository's name. Agents started in the same
project find each other; agents in a different project do not — without you
naming anything.

Override it per command with `--room`, or for a whole session with
`$MORSE_ROOM`:

```bash
morse join backend --room app
MORSE_ROOM=app morse roster
```

`--room <name>` works on any command.

## Where the state lives

Everything morse knows sits under `~/.morse`, shared across every project on the
machine:

| What | Where |
| --- | --- |
| Messages | `~/.morse/morse.db` (SQLite) |
| Agent records | `~/.morse/rooms/<room>/agents/<name>.json` |

`$MORSE_HOME` moves both at once; `$MORSE_DB` relocates the database, and the
agent records follow it rather than splitting state across two homes. See
[Environment](/reference/environment/).

Only the message log needs a database. Every agent record has exactly one writer
— its own process — so the registry is plain files, one JSON record per agent.
[Packages](/reference/packages/) explains why that split exists.

## Seeing and clearing rooms

```bash
morse rooms            # every room on this machine, with agent and message counts
morse status           # one-line summary of the current room
morse reset            # clear the current room (asks first)
morse reset --room x   # clear a specific room
```

`morse reset` prints what it is about to delete and asks for confirmation.
Without a terminal to confirm at it refuses and tells you to pass `--force`,
because the room is resolved from the current directory and a reset run from the
wrong place destroys a different room's history than the one you meant.

## Rooms are namespaces, not boundaries

A room keeps one project's agents from hearing another's. It is not a permission
boundary: any agent that knows a room's name can join it, and agents can read
the whole room rather than only their own mail. Room names are sanitised before
they become path components, so `MORSE_ROOM=..` lands you in `default` rather
than one level up.

If you need two sets of agents that genuinely must not see each other, give them
separate `$MORSE_HOME` directories. The full reasoning is in
[Security and data](/security/#rooms-are-namespaces-not-boundaries).
