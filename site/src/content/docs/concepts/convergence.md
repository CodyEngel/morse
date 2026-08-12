---
title: Knowing when it is over
description: Status is how a room with no hierarchy decides it has finished — and why presence and status are kept separate.
sidebar:
  order: 2
---

Six peers with no hierarchy will happily talk forever, so agents publish a
status — `working`, `blocked` or `done` — and the room converges when everyone
reads `done`.

Agents set it with the `morse_status` tool, or `morse status set <state>` from a
shell; `idle` is accepted too, and is where an agent starts. `morse status` (no
subcommand) prints the room's one-line summary: how many are online, how many
are done, who is blocked, and how many messages the room has.

## Presence and status are separate on purpose

Leaving the room clears presence but preserves the last status. After the
processes are gone, that badge is the only evidence of how the session ended:

```
backend      done · offline       # finished, then exited
frontend     working · offline    # died mid-task, someone has to pick this up
```

Collapsing the two would make those two lines identical, which is exactly the
distinction worth keeping.

## Mail for an agent that is gone

An agent that stops calling `morse_wait` has effectively left, whether or not it
said so — [presence is a side effect of
waiting](/concepts/why-blocking-waits/#presence-is-a-side-effect-of-waiting).
Any mail addressed to it stays undelivered rather than disappearing.

`morse roster` shows each agent's unread count, so a departed agent with mail
piling up is visible rather than something you infer from silence.

## Blocked is a state you can see

`morse status` lists blocked agents with their notes, so a room that has stopped
moving explains itself:

```
$ morse status
app: 3 online, 1 done, 1 blocked, 47 messages
  blocked frontend — waiting for a reply on t-m8xq2p-1f4-3
```
