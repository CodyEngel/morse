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

Zero runtime dependencies. One SQLite file. Works in any harness that speaks MCP.

## Quick start

```bash
npm install && npm run build
```

Open six terminals and put one agent in each:

```bash
morse join product-owner     # terminal 1
morse join frontend          # terminal 2
morse join backend           # terminal 3
morse join devops            # terminal 4
morse join secops            # terminal 5
morse join qe                # terminal 6
```

Each command starts a normal Claude Code session that is already a member of the room, already knows who its teammates are, and already knows the protocol. Then give any one of them a task and watch it spread.

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
morse roles                             Built-in role presets
morse prompt <agent>                    Print the protocol prompt for an agent
morse init                              Write .mcp.json for a plain `claude`
morse reset                             Clear the room
morse mcp                               Run the MCP server
```

`--room <name>` overrides the room on any command.

## Rooms

The store is machine-wide (`~/.morse/morse.db`), and rooms keep projects apart. The room defaults to your git repository's name, so agents started in the same project find each other and agents in a different project do not. Override with `--room` or `$MORSE_ROOM`.

## Roles

Six presets ship with morse — `product-owner`, `frontend`, `backend`, `devops`, `secops`, `qe` — each with a capability blurb and role-specific guidance. See `morse roles`.

They are conveniences, not a fixed cast. Any name works:

```bash
morse join data-science
```

An agent joined this way describes itself with `morse_register`, and from that moment its teammates can find it by capability like anyone else.

## Other harnesses

`morse join` targets Claude Code by default. Point it elsewhere with `--harness`, or wire the server up by hand — it is a standard MCP stdio server:

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

`MORSE_AGENT` is the identity. Everything else is optional.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MORSE_AGENT` | — | This session's identity. |
| `MORSE_ROOM` | git repo name | Which room to join. |
| `MORSE_HOME` | `~/.morse` | Where the store lives. |
| `MORSE_DB` | `$MORSE_HOME/morse.db` | Full path to the store. |
| `MORSE_WAIT_SECONDS` | `50` | Default park duration for `morse_wait`. |
| `MORSE_OPERATOR` | `operator` | Your name when you use `morse send` / `morse ask`. |

Claude Code's default MCP tool timeout is effectively unbounded, so a longer `MORSE_WAIT_SECONDS` is safe there. The 50-second default is chosen to stay inside stricter harnesses.

## Tests

```bash
npm test
```

Covers the store and delivery semantics, the MCP server over real stdio, and the acceptance case: six independent processes started in parallel that discover each other, route questions by capability, answer them, and converge on `done`.

## License

Apache-2.0
