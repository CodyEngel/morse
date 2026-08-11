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

Everything agents say to each other is written unencrypted, in two places under `~/.morse`, shared across every project on the machine:

| What | Where | Contains |
| --- | --- | --- |
| Messages | `morse.db` (SQLite) | message bodies, threads, who was addressed, read cursors |
| Agent records | `rooms/<room>/agents/<name>.json` | names, self-descriptions, skills, status notes, process IDs, working directories |

Agents quote code, paths, logs and errors at each other constantly, so assume both contain whatever your agents have been looking at.

Morse creates the database `0600` and every directory under `~/.morse` `0700`. Agent records get the same `0600` treatment and are written whole, via a temporary file and a rename, so a reader never sees a half-written record. Other accounts on a shared machine cannot read either. That is the limit of the protection:

- **Any process running as you can read and modify the store.** There is no per-agent authentication. An agent is whatever `MORSE_AGENT` says it is.
- **There is no encryption at rest.** Encrypting with a key sitting on the same disk, readable by the same user, would protect against nothing in the threat model above. If you need encryption, use full-disk encryption or a dedicated filesystem.
- **Nothing is sent anywhere.** Morse has no network code and no telemetry. It is a local file and some processes reading it.

### Rooms are namespaces, not boundaries

A room keeps one project's agents from hearing another's. It is not a permission boundary:

- Any agent that knows a room's name can join it.
- **Agents can read the whole room, not just their own mail.** `morse_history` returns traffic addressed to other agents, by design — it is how an agent catches up after joining late.
- Rooms share one database file, so isolation between messages is a `WHERE` clause, not a sandbox. Agent records are separated by directory, which is not a boundary either — the same user owns all of them.

A room name is a path component (`~/.morse/rooms/<room>/`) as well as a query value, so it is sanitised before it is used as either: anything outside `[a-z0-9._-]` is replaced, and a name that is only dots is refused rather than mangled. `MORSE_ROOM=..` lands you in `default`, not one level up. Agent names get the same treatment, for the same reason — they become filenames — and are lowercased, so `Backend` and `backend` are one agent rather than two on a case-sensitive filesystem and a silent collision on a case-insensitive one.

Use separate `MORSE_HOME` directories if you need two sets of agents that genuinely must not see each other. Setting only `MORSE_DB` relocates the records too — they follow the store rather than splitting state across two homes.

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

### Morse reads files you wrote for other tools

Morse also discovers agent definitions in the folders other harnesses keep — `.claude/agents`, `.codex/agents`, `.pi/agent/agents` — and the body of one of those files (Codex's `developer_instructions`) becomes a system prompt exactly as a morse role does. Two consequences worth stating plainly:

- **A file you wrote for another tool can now instruct a morse agent.** Cloning a repository with a `.claude/agents/` directory is enough; nothing needs copying into `.morse/roles`. Review those directories on the same terms as a role file.
- **The blast radius is a superset of what it was.** More directories are read, and they are directories morse does not define the contents of.

Against that, discovery is deliberately narrow:

- **Plugins are manifests, not code.** A plugin is a JSON file describing directories and field names. Morse reads config files; it never loads or executes plugin code, so adding an ecosystem cannot itself run anything.
- **Only agent definitions are read.** Not settings, not credentials, not MCP configuration. Morse looks in one named subdirectory per ecosystem and reads nothing else.
- **Paths are contained at every level.** A role name cannot become a path, a manifest directory cannot climb out of its search root, and a file is refused if its resolved location is outside the directory being searched. That last one matters: git preserves symlinks, so `.morse/roles/backend.md` committed as a link to `~/.ssh/id_rsa` would otherwise put a private key into a system prompt on `morse join`.
- **Provenance is always visible.** `morse roles` labels each definition with the plugin that supplied it and lists every directory searched; `morse join` names the file and the plugin. A manifest inside a project that redefines a built-in ecosystem is disclosed, since it may have arrived with a clone.
- **Nothing is refused in silence.** A file found and then dropped is reported with the reason — outside the directory searched, unreadable, unparseable. Silent under-discovery and a working feature look identical from outside, which is what makes it dangerous: a user who cannot tell a typo from a rejected file cannot audit what their agents are being told.
- **The TOML reader refuses rather than guesses.** It reads `key = "value"`, `key = """multi-line"""` and comments; anything else refuses the whole file. A prompt body truncated at a delimiter the reader did not understand would be a silently wrong system prompt, which is worse than no role.
- **It can be turned off.** `--no-plugins`, or `MORSE_PLUGINS=off`, restores the earlier behaviour exactly: only `.morse/roles` is read.

### Messages are untrusted text

Message content is authored by language models and can contain anything, including terminal escape sequences. Morse escapes control characters before printing to a terminal, so a message cannot forge output or drive your terminal emulator. If you build something that consumes morse data directly, do your own escaping — the store holds the raw text.

### Morse does not sandbox agents

Coordination and permission are separate concerns. Morse routes messages; it has no ability to stop an agent doing anything, and a role file saying "you do not write code" is a convention the agent can ignore. Constrain agents with your harness — `--permission-mode`, `--allowedTools`, sandboxing — not with morse.
