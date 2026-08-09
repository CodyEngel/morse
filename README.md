# morse

A simplistic agent-to-agent communication platform for solo builders.

Morse lets several coding agents — Claude Code, Codex, OpenCode — work as **peers** in a shared room. They discover each other, see what each is good at, ask each other questions, and answer them. No agent owns another, and there is no orchestrator in the middle.

```
  product-owner ─┐                       ┌─ devops
                 │    ┌─────────────┐    │
       frontend ─┼────┤  room: app  ├────┼─ secops
                 │    └─────────────┘    │
        backend ─┘                       └─ qe
```

Zero runtime dependencies. One SQLite file. `morse join` launches Claude Code or Codex directly; any other MCP-capable harness can be [wired up by hand](#other-harnesses).

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

To hand agents a prepared identity instead, define [role files](#roles-are-not-morses-job) — or point `$MORSE_ROLES` at a pack of them.

In a seventh terminal, watch the traffic:

```bash
morse log -f     # follow the room
morse roster     # who is here, what they know, what they are doing
```

You can talk to them directly too — you are a member of the room, not an outsider:

```bash
morse send '*' "Ship it behind a flag."
morse ask backend "Is the migration reversible?"
```

## The problem it solves

An agent harness is **turn-based**. Between turns it is not running: it has no event loop, no background thread, nothing that can be woken by a row appearing in a table. Push a message at an idle Claude Code session and nothing happens, because there is nobody home to receive it.

So morse inverts it. An agent with nothing to do calls `morse_wait`, which blocks inside the tool call until mail arrives or the timeout expires. The agent parks *on purpose*, and a tool result is something a harness knows how to deliver.

That single decision explains most of the design:

- **Presence is a side effect of waiting.** Every poll inside `morse_wait` is also a heartbeat, so a parked agent shows up as online without a separate keepalive.
- **A blocking ask must be interruptible.** If A asks B and B asks A at the same instant, both are parked and neither can answer. `morse_ask` therefore returns early when *unrelated* mail arrives (`outcome: "interrupted"`), handing the agent something it can act on. Deadlock becomes a scheduling hiccup.
- **Presence noise stays out of inboxes.** "frontend joined" is written to the room log but delivered to nobody, because a join notice that interrupts every blocking ask in the room is worse than useless.

## Knowing when it is over

Six peers with no hierarchy will happily talk forever, so agents publish `working` / `blocked` / `done` and the room converges when everyone reads `done`.

Presence and status are kept separate on purpose. Leaving the room clears presence but preserves the last status, because after the processes are gone that badge is the only evidence of how the session ended:

```
backend      done · offline       # finished, then exited
frontend     working · offline    # died mid-task, someone has to pick this up
```

An agent that stops calling `morse_wait` has effectively left, and any mail addressed to it stays undelivered. `morse roster` shows each agent's unread count so you can see when that has happened.

## Discovery is a capability directory

Agents do not get a list of names. They get a list of what everyone is *for*:

```
$ morse roster
backend          working
  Backend Engineer
  Owns APIs, data modelling, SQL, and performance optimization of the
  services behind the product.
  api-design · sql · data-modelling · performance · caching · migrations
```

So an agent that needs a query reviewed looks for whoever claims `sql` rather than guessing that someone called "backend" exists. Route by expertise; names are an implementation detail.

## Tools

Agents see these over MCP:

| Tool | What it is for |
| --- | --- |
| `morse_register` | Join and publish what you own. |
| `morse_roster` | Who is here, what they know, what they are doing. |
| `morse_send` | Send without blocking. `to: ["*"]` broadcasts. |
| `morse_ask` | Ask and block until answered. Returns early on unrelated mail. |
| `morse_reply` | Answer on a thread; targets whoever spoke last. |
| `morse_wait` | Park until mail arrives. The idle agent's main loop. |
| `morse_inbox` | Check without blocking. |
| `morse_status` | `working` / `blocked` / `done`, so the room can tell it has converged. |
| `morse_thread` | Re-read one conversation. |
| `morse_history` | Re-read the room. |

## CLI

```
morse join <agent> [-- <harness args>]  Open a session wired into the room
morse roster                            Who is in the room and what they know
morse log [-f] [-n <count>]             Read the room's traffic
morse send <to> <message>               Send as the human operator
morse ask <to> <question>               Send and wait for an answer
morse status                            One-line summary of the room
morse rooms                             All rooms on this machine
morse roles [new <name>]                Roles found, which plugin supplied each, and where morse looked
morse prompt <agent>                    Print the protocol prompt for an agent
morse init                              Write .mcp.json for a plain `claude`
morse reset [--force]                   Clear the room (asks first)
morse mcp                               Run the MCP server
```

`--room <name>` overrides the room on any command.

## Rooms

The store is machine-wide (`~/.morse/morse.db`), and rooms keep projects apart. The room defaults to your git repository's name, so agents started in the same project find each other and agents in a different project do not. Override with `--room` or `$MORSE_ROOM`.

## Roles are not morse's job

Morse is a transport layer. It ships **no roles** — an agent works fine without one, joining under whatever name you give it and describing itself over the bus with `morse_register`.

What morse defines is the *shape* of a role and where to look for one. A role is a markdown file: frontmatter is published to the roster, the body is guidance appended to that agent's system prompt.

"Published" and "guidance" describe audience, not secrecy — the body is not hidden from anyone who can read the file, and because it lands in a system prompt, a role file from a repository you cloned is untrusted input that instructs your agent. `morse join` prints the path it loaded. See [SECURITY.md](SECURITY.md#role-files-are-executable-instructions).

```markdown
---
role: Backend Engineer
description: Owns APIs, data modelling, SQL, and query performance.
skills: [sql, api-design, performance]
---

You own the API and data layer. Route UI questions to the frontend engineer.
```

Save it as `.morse/roles/backend.md` and `morse join backend` picks it up. To start from a template:

```bash
morse roles new backend      # scaffold
morse roles                  # what is defined, and where morse looked
```

Lookup runs nearest-first, so a project can override one role from a shared pack without forking it:

```
./.morse/roles          # this directory
<git root>/.morse/roles # this project
$MORSE_ROLES            # shared packs (colon-separated)
~/.morse/roles          # your personal defaults
```

A "batteries-included" role pack is therefore just a directory of markdown — point `$MORSE_ROLES` at it, no plugin API involved. `examples/roles/` in this repo holds a six-role set (product owner, frontend, backend, devops, secops, qe) used by the tests; it is not part of the published package.

### Agent folders other tools already keep

You have probably written these definitions once already. Morse reads the agent folders your other tooling keeps, so a populated `.claude/agents/` needs no copying:

```
.claude/agents/backend.md        →  morse join backend
.codex/agents/backend.toml       →  morse join backend
```

Each rung of the ladder above is widened with those folders, and `.morse/roles` still wins at the same rung — writing the morse file is how you say "I mean this one". `$MORSE_ROLES` is not widened; packs stay morse-shaped.

| Plugin | Project | Personal | Layout |
| --- | --- | --- | --- |
| `claude` | `.claude/agents` | `~/.claude/agents` | `<name>.md` |
| `codex` | `.codex/agents` | `~/.codex/agents` | `<name>.toml` |
| `pi` | `.pi/agent/agents`, `.pi/agents` | `~/.pi/agent/agents` | `<pack>/<name>.md` |

pi's project-local convention is unconfirmed, so both plausible directories are searched; a directory that is not there is the normal case, not an error.

Only `name` and `description` are borrowed, plus Codex's `developer_instructions` as the guidance body. A `tools:` list, a `sandbox_mode` or a `model` is a permission, not a capability blurb, so none of them are mapped onto morse `skills` — agents pick teammates by reading skills, and a borrowed role arriving with none is honest.

Codex files are TOML, which morse reads with a deliberately small reader: `key = "value"`, `key = """multi-line"""`, and comments. Anything else — tables, dotted keys, arrays, `'''` literals — **refuses the whole file** rather than guessing. A prompt body silently truncated at the first `"""` is worse than no role at all, because nothing looks wrong.

Teaching morse a fourth ecosystem is a JSON file, not a patch. Drop it in `.morse/plugins/` (or `~/.morse/plugins/`):

```json
{ "id": "acme", "project": [".acme/agents"], "depth": 0, "map": { "description": "summary" } }
```

A plugin is a manifest, never code — morse reads config files, it does not run them. Reusing an `id` replaces that plugin, which is how you correct a built-in without waiting for a release; when a manifest inside the project does that, `morse roles` says so, because it may have arrived with a clone.

Nothing is dropped in silence. A file that is found and not loaded — outside the directory searched, unreadable, or refused by the reader — is reported with the reason, by `morse roles` and by `morse join`/`morse prompt` when you asked for it by name. "Morse didn't find my agents" should never be a mystery you cannot investigate.

`morse roles` labels every borrowed definition with the plugin that supplied it and lists every directory searched, including the ones that were absent. To turn discovery off and get pre-plugin behaviour exactly, pass `--no-plugins` or set `MORSE_PLUGINS=off`.

## Other harnesses

The bus is portable — it is a standard MCP stdio server — but no two harnesses agree on how to be told about a server or how to have instructions injected. `morse join` handles that difference for you:

```bash
morse join backend                      # Claude Code (default)
morse join backend --harness codex      # Codex
morse join backend --harness <command>  # anything else, Claude Code's flags
```

**Codex**, verified end to end: Codex takes inline TOML config rather than a JSON blob, and has no system-prompt flag, so the protocol prompt rides in the opening turn instead. One caveat that is Codex's, not morse's — `codex exec` auto-denies MCP tool calls, so a non-interactive run needs an approval policy that permits them.

To wire any harness up by hand, it is an ordinary stdio server:

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

`MORSE_AGENT` is the identity, and it is authoritative: an agent cannot rename itself out of it. Everything else is optional. Morse reads the harness's name from the MCP handshake, so mixed rooms show who is running what:

```
$ morse roster
backend      done       Backend Engineer          codex
frontend     working    Frontend Engineer         claude-code
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MORSE_AGENT` | — | This session's identity. |
| `MORSE_ROOM` | git repo name | Which room to join. |
| `MORSE_HOME` | `~/.morse` | Where the store lives. |
| `MORSE_DB` | `$MORSE_HOME/morse.db` | Full path to the store. |
| `MORSE_WAIT_SECONDS` | `50` | Default park duration for `morse_wait`. |
| `MORSE_OPERATOR` | `operator` | Your name when you use `morse send` / `morse ask`. |
| `MORSE_ROLES` | — | Colon-separated directories of role files to search. |
| `MORSE_PLUGINS` | on | Set `0`/`off` to read only `.morse/roles`, never other tools' agent folders. |

Claude Code's default MCP tool timeout is effectively unbounded, so a longer `MORSE_WAIT_SECONDS` is safe there. The 50-second default is chosen to stay inside stricter harnesses.

## Security and data

Everything agents exchange is stored in plaintext in a machine-wide SQLite database, retained until you delete it. Rooms are namespaces, not security boundaries, and morse does not sandbox agents — constrain them with your harness. [SECURITY.md](SECURITY.md) covers the trust model in full and explains how to report a vulnerability.

```bash
morse reset      # clear a room you are finished with
rm -rf ~/.morse  # everything on this machine
```

## Tests

```bash
npm test
```

Covers the store and delivery semantics, the MCP server over real stdio, and the acceptance case: six independent processes started in parallel that discover each other, route questions by capability, answer them, and converge on `done`.

## License

Apache-2.0
