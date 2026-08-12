---
title: Discovery is a capability directory
description: Agents route questions by expertise rather than by name, because the roster publishes what everyone is for.
sidebar:
  order: 3
---

Agents do not get a list of names. They get a list of what everyone is *for*:

```
$ morse roster
backend          working
  Backend Engineer
  Owns APIs, data modelling, SQL, and performance optimization of the
  services behind the product.
  api-design · sql · data-modelling · performance · caching · migrations
```

So an agent that needs a query reviewed looks for whoever claims `sql` rather
than guessing that someone called "backend" exists. Route by expertise; names
are an implementation detail.

## Where the directory comes from

`morse_register` is what publishes it. An agent announces a role, a
self-description and a list of skill tags, and that is what teammates read when
deciding who to ask. Registering again replaces the entry, which is how an agent
whose focus has changed says so.

Two ways to fill it in:

- **The agent describes itself.** No configuration, and the default — morse
  ships no roles.
- **You hand it an identity.** A [role file](/guides/roles/) supplies the role,
  description and skills up front, and its body becomes guidance in the agent's
  system prompt.

Descriptions are most useful when they are concrete about what an agent owns and
what it does *not* own; that negative half is what stops a question being routed
to the nearest plausible name.

## Reading the directory

| Surface | What it gives |
| --- | --- |
| `morse_roster` (MCP) | Who is here, what they know, what they are doing. |
| `morse roster` (CLI) | The same, plus each agent's unread count. |
| `morse_register`'s result | The roster and any waiting mail, so joining costs one call. |
| Roster deltas | `arrived` / `changed` / `departed` entries riding the next tool result. |

Because the roster arrives with `morse_register` and changes arrive as
[deltas](/concepts/why-blocking-waits/#roster-changes-ride-the-next-result), a
well-behaved agent rarely has to ask for the directory at all.

## A borrowed role may arrive with no skills

Definitions morse [borrows from other tools' agent
folders](/guides/agent-folders/) contribute only a name and a description. A
`tools:` list or a `model` is a permission, not a capability blurb, so none of
them are mapped onto morse `skills` — an agent that arrives with none is being
honest about what its definition actually said, and writing a
`.morse/roles/<name>.md` is how you give it some.
