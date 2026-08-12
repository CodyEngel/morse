---
title: Role files
description: The shape of a role, where morse looks for one, and why a role file from a cloned repository is untrusted input.
sidebar:
  order: 1
---

Morse is a transport layer. It ships **no roles** — an agent works fine without
one, joining under whatever name you give it and describing itself over the bus
with `morse_register`.

What morse defines is the *shape* of a role and where to look for one.

## The shape of a role

A role is a markdown file. Frontmatter is published to the roster; the body is
guidance appended to that agent's system prompt.

```markdown
---
role: Backend Engineer
description: Owns APIs, data modelling, SQL, and query performance.
skills: [sql, api-design, performance]
---

You own the API and data layer. Route UI questions to the frontend engineer.
```

Save it as `.morse/roles/backend.md` and `morse join backend` picks it up.

| Field | Goes to |
| --- | --- |
| `role` | The roster, as the human-readable role line |
| `description` | The roster — what teammates read when deciding who to ask |
| `skills` | The roster, as capability tags agents route by |
| Body | The agent's system prompt, as guidance |

:::caution[The body is instructions, not documentation]
"Published" and "guidance" describe audience, not secrecy. The body is not
hidden from anyone who can read the file, and because it lands in a system
prompt, **a role file from a repository you cloned is untrusted input that
instructs your agent**. `morse join` prints the path it loaded. Read role files
from repositories you do not control before joining with them, exactly as you
would review a `CLAUDE.md` or a git hook. See [Security and
data](/security/#role-files-are-executable-instructions).
:::

## Scaffold one

```bash
morse roles new backend      # writes .morse/roles/backend.md from a template
morse roles                  # what is defined, and where morse looked
```

`morse roles new` refuses a name that could become a path — the name becomes a
filename — and refuses to overwrite a file that already exists.

## Where morse looks

Lookup runs nearest-first, so a project can override one role from a shared pack
without forking it:

```
./.morse/roles          # this directory
<git root>/.morse/roles # this project
$MORSE_ROLES            # shared packs (colon-separated)
~/.morse/roles          # your personal defaults
```

Each rung except `$MORSE_ROLES` is also widened with [the agent folders other
tools already keep](/guides/agent-folders/), and `.morse/roles` still wins at the
same rung — writing the morse file is how you say "I mean this one".
`$MORSE_ROLES` is not widened; packs stay morse-shaped.

## Role packs are just directories

A "batteries-included" role pack is a directory of markdown files — point
`$MORSE_ROLES` at it, no plugin API involved.

```bash
MORSE_ROLES=~/roles/product-team:~/roles/platform morse join backend
```

`examples/roles/` in the morse repository holds a six-role set (product owner,
frontend, backend, devops, secops, qe) used by the tests. It is deliberately not
part of the published package: installing morse should not install six opinions
about what a product owner is.

## Nothing is dropped in silence

A file that is found and not loaded — outside the directory searched, unreadable,
or refused by the reader — is reported with the reason, by `morse roles` and by
`morse join` / `morse prompt` when you asked for it by name.

```
skipped codex ~/.codex/agents/backend.toml — unparseable
```

The reasons are `outside the searched directory`, `unreadable` and
`unparseable`.

"Morse didn't find my agents" should never be a mystery you cannot investigate.
`morse prompt <agent>` exits non-zero when the role you named was found, refused,
and had nothing to fall back on, so a script can tell the difference between "no
role" and "a role we would not load".
