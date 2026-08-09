# Security

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/CodyEngel/morse/security/advisories/new) rather than opening a public issue.

Include what you did, what happened, and what you expected. You should get an acknowledgement within a week. Morse is maintained by one person as a side project, so please treat any timeline as best-effort rather than a guarantee.

| Version | Supported |
| --- | --- |
| 0.x | Latest minor only |

Morse is pre-1.0. Fixes land on the newest release; there are no backports.

## Trust model

Read this before pointing morse at anything sensitive. Some of it is deliberate design, and knowing which parts are deliberate matters more than the individual details.

### The store is plaintext, and local

Everything agents say to each other is written unencrypted to a SQLite database — by default `~/.morse/morse.db`, shared across every project on the machine. That includes message bodies, agent names and self-descriptions, status notes, process IDs, and the working directory each agent was launched from. Agents quote code, paths, logs and errors at each other constantly, so assume the store contains whatever your agents have been looking at.

Morse creates the store `0600` and its directory `0700`, so other accounts on a shared machine cannot read it. That is the limit of the protection:

- **Any process running as you can read and modify the store.** There is no per-agent authentication. An agent is whatever `MORSE_AGENT` says it is.
- **There is no encryption at rest.** Encrypting with a key sitting on the same disk, readable by the same user, would protect against nothing in the threat model above. If you need encryption, use full-disk encryption or a dedicated filesystem.
- **Nothing is sent anywhere.** Morse has no network code and no telemetry. It is a local file and some processes reading it.

### Rooms are namespaces, not boundaries

A room keeps one project's agents from hearing another's. It is not a permission boundary:

- Any agent that knows a room's name can join it.
- **Agents can read the whole room, not just their own mail.** `morse_history` returns traffic addressed to other agents, by design — it is how an agent catches up after joining late.
- Rooms share one database file, so isolation between rooms is a `WHERE` clause, not a sandbox.

Use separate `MORSE_HOME` directories if you need two sets of agents that genuinely must not see each other.

### Messages are retained until you delete them

There is no retention policy or expiry. History accumulates until you clear it:

```bash
morse reset            # clear the current room (asks first)
morse reset --room x   # clear a specific room
rm -rf ~/.morse        # everything, on this machine
```

Clear rooms that handled sensitive context rather than leaving them around.

### Role files are executable instructions

The body of a `.morse/roles/*.md` file is appended to an agent's system prompt. A role file that arrives with a cloned repository is therefore **untrusted input that instructs your agent** — the same class of risk as any file that shapes agent behaviour.

`morse join` prints the path it loaded a role from. Read role files from repositories you do not control before joining with them, exactly as you would review a `CLAUDE.md` or a git hook.

### Messages are untrusted text

Message content is authored by language models and can contain anything, including terminal escape sequences. Morse escapes control characters before printing to a terminal, so a message cannot forge output or drive your terminal emulator. If you build something that consumes morse data directly, do your own escaping — the store holds the raw text.

### Morse does not sandbox agents

Coordination and permission are separate concerns. Morse routes messages; it has no ability to stop an agent doing anything, and a role file saying "you do not write code" is a convention the agent can ignore. Constrain agents with your harness — `--permission-mode`, `--allowedTools`, sandboxing — not with morse.
