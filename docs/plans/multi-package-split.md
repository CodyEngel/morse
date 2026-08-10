# Splitting morse into three packages

Status: **draft for review, v5.** Nothing here is implemented.

Diagram: [`multi-package-split.excalidraw`](./multi-package-split.excalidraw) —
drop it on excalidraw.com or open it with the VS Code / Obsidian plugin.

| Package | What it is | Storage | Depends on | `bin` | npm |
| --- | --- | --- | --- | --- | --- |
| `@morse-ai/bus` | The bus: messages, delivery, blocking waits | SQLite | **nothing** | `morse-bus` | org ✅ |
| `@morse-ai/registry` | The default registry: who exists, what they can do, whether they are here | plain files | **nothing** | `morse-registry` | org ✅ |
| `morse-ai` | The product: the composed MCP server and the protocol prompt | — | both | `morse` | published (0.2.0) |

The flagship stays unscoped — it is what people install, and `next`/`@next/*`,
`vite`/`@vitejs/*`, `eslint`/`@eslint/*` all use that shape. **Bin names are
independent of package names**, so the CLIs remain `morse`, `morse-bus` and
`morse-registry` regardless of the scope.

Two things carry the design:

1. **`@morse-ai/bus` does not depend on `@morse-ai/registry`.** It depends on a **four-method
   interface it defines itself**, which `@morse-ai/registry` satisfies by default and
   anyone else can satisfy instead — see
   [Decision 3](#decision-3--the-bus-depends-on-an-interface-not-a-package).
2. **Every package ships a CLI, and MCP stays a single composed server.** The two are
   not alternatives: MCP is the primary agent transport, the CLI is a second one plus
   the way each layer is operated and inspected on its own — see
   [Decision 6](#decision-6--every-package-ships-a-cli-mcp-stays-one-composed-server).

---

## What changed

- **v1 → v2.** Both packages shared `~/.morse/morse.db` and split the `agents` table
  by column. Counting the *writers* showed only the message log needs a database at
  all, so the registry became files and the shared table went away.
- **v2 → v3.** `morse-book` is now `morse-registry` — it is an index of agents, and
  the pun was doing no work. And the bus no longer depends on it: the dependency is
  inverted onto an interface, so both sub-packages have zero dependencies and the
  registry is swappable.
- **v3 → v4.** `morse-comms` is now `morse-bus`, matching the `Bus` class it exports.
  Every package now ships a CLI as part of this release rather than as a follow-on,
  which closes the open question: CLIs need no shared transport, so MCP stays a single
  composed server in `morse-ai` and no fourth package appears.
- **v4 → v5.** The `morse-ai` npm org exists, so the sub-packages are scoped —
  `@morse-ai/bus` and `@morse-ai/registry`. No name has to be raced for, so the
  claiming work leaves Phase 0 entirely and becomes part of shipping.

## The finding

**`Store` is interlocked in both directions.** `register()` — the obvious registry
method — reaches into the message tables twice:

```ts
// store.ts:140
const cursor = this.maxMessageId(room);                 // messages
// store.ts:159
this.systemMessage(room, `${name} joined the room.`);   // messages + deliveries
```

and the message path reaches back into `agents` three times (`store.ts:250,271`,
`wait.ts:42,81`). So "registry owns `agents`, the bus owns `messages`" is a cycle.

**But every agent write is single-writer.** All six write sites are scoped to one row,
and in each case the caller is that agent's own process:

```
store.ts:112  UPDATE agents SET role/description/... WHERE room = ? AND name = ?
store.ts:143  INSERT INTO agents ...
store.ts:181  UPDATE agents SET last_seen  = ?         WHERE room = ? AND name = ?
store.ts:186  UPDATE agents SET status     = ?         WHERE room = ? AND name = ?
store.ts:201  UPDATE agents SET present    = 0         WHERE room = ? AND name = ?
store.ts:289  UPDATE agents SET cursor     = ?         WHERE room = ? AND name = ?
```

The only exception is `morse reset`, which deletes the lot — a destructive admin
operation, not concurrent access.

## Decision 1 — only the message log needs a database

| Data | Writers | Needs a DB? |
| --- | --- | --- |
| Roles, plugins | none — read-only from disk | No. Already files. |
| Identity, role, description, skills | one (itself) | **No** |
| Status, status note | one (itself) | **No** |
| Presence: `last_seen`, `present`, `pid` | one (itself) | **No** |
| Cursor | one (itself) | **No** |
| **Messages + deliveries** | **many** | **Yes** |

**In-memory** is out for anything cross-agent: N independent OS processes, no shared
memory. It only works behind a long-lived broker, and morse's whole thesis is that
there isn't one — plus the README treats post-mortem state as load-bearing ("after the
processes are gone that badge is the only evidence of how the session ended"), so a
daemon would have to persist anyway.

**Files** are sufficient for every single-writer row above.

**The message log needs a store, and not for concurrency — for total order.**
`inbox()` is `m.id > agent.cursor`. That requires a globally monotonic id across N
processes, which `messages.id INTEGER PRIMARY KEY AUTOINCREMENT` provides for free.
The file alternative is timestamps, and `now()` is `Date.now()` — millisecond
resolution. Two messages from different processes in the same millisecond makes the
order ambiguous, and an ambiguous order lets a cursor skip a message. Silent message
loss is the one failure this system cannot absorb. The codebase already knows this:
`newThreadId` mixes in pid and a counter precisely because ms collisions happen.

## Decision 2 — the registry is files, the bus is SQLite

```
~/.morse/
├── morse.db                            @morse-ai/bus       · SQLite, WAL
│      messages · deliveries · cursors
├── rooms/<room>/agents/<name>.json     @morse-ai/registry  · one writer: that agent
├── roles/*.md                          @morse-ai/registry  · unchanged
└── plugins/*.json                      @morse-ai/registry  · unchanged
```

An agent record is the current row, minus `cursor`, minus `last_seen`:

```json
{
  "name": "backend",
  "role": "Backend Engineer",
  "description": "Owns APIs, data modelling, SQL, and query performance.",
  "skills": ["sql", "api-design", "performance"],
  "status": "working",
  "statusNote": null,
  "harness": "claude-code",
  "pid": 41207,
  "cwd": "/Users/cody/Dev/app",
  "joinedAt": 1754800000000,
  "present": true
}
```

- **`last_seen` is the file's mtime.** `heartbeat()` becomes `utimesSync`: no content
  rewrite, which matters because `wait.ts` calls it every 200ms per agent. Measured on
  APFS under `~/`: sub-millisecond resolution (eight `utimes` calls 3ms apart produced
  eight distinct `mtimeMs` values, one of them `2.999`) at **5.3µs per call** — three
  orders of magnitude finer than the poll interval, and cheaper than the SQL UPDATE it
  replaces, with no WAL contention. CI's `ubuntu-latest` leg covers the Linux side.
- **Writes are temp-file + rename**, so a concurrent reader sees the old record or the
  new one, never a truncated one.
- `online` and `alive` derive exactly as today: `present && status !== "offline" &&
  now() - mtime < ONLINE_WINDOW_MS`, and `present && isRunning(pid)`.

**The `rooms` table disappears.** Room existence becomes directory existence. Safe to
drop because `topic` is never populated: `ensureRoom`'s only caller is `register()`
(`store.ts:103`), which never passes one, so the column has always been NULL.
`morse rooms` becomes `readdir(~/.morse/rooms)` ∪ `SELECT DISTINCT room FROM messages`,
with agent counts from the directory and message counts from SQL — which also means a
standalone `Bus` user who never registers cannot produce a room `morse rooms` fails to
see.

### The three costs, stated plainly

1. **mtime as presence** makes an external `touch` indistinguishable from a heartbeat —
   a backup tool, an editor, an `rsync` without `-t`. Resolution and cost are measured
   and fine; *this* risk is the unmeasurable one, and the escape hatch is a
   `<name>.seen` sidecar that `heartbeat()` touches, leaving the record file stable.
   Two files per agent instead of one. Only worth taking if it actually bites.
2. **The registry's phase stops being code motion** and becomes a reimplementation on a
   new substrate. That is the real risk in this plan; it gets its own phase, and the
   existing tests are the contract (see [Sequencing](#sequencing)).
3. **Two substrates instead of "one SQLite file."** The counter-argument is that
   `~/.morse` becomes uniformly inspectable — roles are files, plugins are files,
   agents are files, and the single thing that is not a file is the single thing that
   cannot be one. `cat ~/.morse/rooms/app/agents/backend.json` beats opening a SQLite
   database, and it fits what SECURITY.md already says about plaintext and
   inspectability.

Not a cost: **atomicity.** `grep -rniE "BEGIN|COMMIT|transaction" src/` returns
nothing. Morse uses no transactions today — `register()` is already four unprotected
statements — so splitting the store loses nothing that exists. Two processes
registering the same name still race, and still produce two join announcements,
exactly as they do now.

## Decision 3 — the bus depends on an interface, not a package

`@morse-ai/bus` defines the registry contract it needs, and takes an implementation at
construction. It does not import `@morse-ai/registry`, does not know it exists, and has
**zero dependencies**.

```ts
// packages/bus/src/registry.ts — the entirety of what the bus knows about a registry.

export type Status = "idle" | "working" | "blocked" | "done" | "offline";

export interface Registry {
  /** Note that `name` is alive right now. Called on every wait poll, ~5×/s/agent. */
  heartbeat(room: string, name: string): void | Promise<void>;

  /** Who is addressable in `room`. Advisory — drives a warning, never a refusal. */
  names(room: string): string[] | Promise<string[]>;

  /** This agent's current state, so a blocking wait can put back what it displaced. */
  status(room: string, name: string): Status | undefined | Promise<Status | undefined>;

  /** Publish coarse work state. Called when a wait blocks, and when it unblocks. */
  setStatus(room: string, name: string, status: Status, note?: string | null): void | Promise<void>;
}

/**
 * Running with no registry, chosen explicitly. `registry` is a required constructor
 * argument so that this is something you asked for, not something you defaulted into.
 *
 * Gives up exactly three things: presence (nobody is ever `online`), unknown-recipient
 * warnings, and status publication — an agent parked in `morse_ask` no longer shows as
 * `blocked`. Keeps everything else, including `morse_ask`'s deadlock avoidance, which
 * is driven by `inbox()` returning unrelated mail (`wait.ts`) and never consults
 * status: delivery, broadcast, threading, cursors, `interrupted` semantics.
 */
export const unregistered: Registry;
```

```ts
const bus = new Bus({ registry: new FileRegistry() });   // morse-ai wires this
const bus = new Bus({ registry: myOwnThing });           // anything with the 4 methods
const bus = new Bus({ registry: unregistered });         // deliberately none
```

**Every method traces to a call site that exists today:**

| Method | Replaces | Called from |
| --- | --- | --- |
| `heartbeat` | `store.touch` | `wait.ts:42,81` — the poll loop |
| `names` | `roster` inside `unknownRecipients` | `store.ts:250` |
| `status` | `store.getAgent(...)?.status` | `mcp/server.ts:190` — capture before blocking |
| `setStatus` | `store.setStatus` | `mcp/server.ts:143,149,192,198` — block, then unblock |

**Why there is a read as well as a write.** `morse_wait` with a `thread_id` captures
the agent's current status, sets `blocked`, and puts the original back if no reply
arrives (`server.ts:190,198`) — the comment there explains why: leaving a resuming
agent as `idle` lets the room conclude it has finished. A write-only port cannot do
that, so the port is four methods rather than three. It also means `setStatus` must
accept the **whole** `Status` union, not just the three values the bus writes literally:
`previous` is whatever was read back, and `morse_status` — a *registry* tool — can have
set `done`.

**What is deliberately *not* in it matters as much:**

- **`publish` is gone.** v2 had `join()` ask the registry whether this was a first-time
  joiner. It does not need to: the bus already knows, because a first-time joiner is one
  with no `cursors` row. That is also more correct — the "x joined the room"
  announcement is about acquiring a *mailbox*, not about appearing in a directory. It
  preserves both existing tests exactly (line 78: no cursor → seed at `maxMessageId`
  and announce; line 89: cursor exists → neither).
- **`names()` returns strings, not `Agent[]`.** Comms never reads a peer's role,
  skills or status. Handing it the full record would invite it to start.
- **`publish`, `get`, `depart`, `forgetRoom`, `listRooms`, role discovery** are all
  real registry API — `morse-ai` calls them on the concrete implementation. They are
  simply not part of the port, because the port is *what the bus needs*, not *what a
  registry does*.

**The signatures permit `Promise` but the default never returns one.** `FileRegistry`
is fully synchronous, so the default path pays nothing. Allowing a promise costs
the bus one `await` at three call sites — all already inside `async` functions — and is
what keeps a network- or daemon-backed registry implementable. The one place to be
careful is `heartbeat`, which runs in the 200ms poll: a registry that blocks there
slows every agent's mail delivery, so the contract says it must be cheap and must not
throw.

**Conformance is structural.** `@morse-ai/registry` does not import the `Registry` type,
so there is no dependency in either direction. `morse-ai` depends on both and is where
the two meet, so its test suite carries the one-line proof:

```ts
const _conforms: Registry = new FileRegistry();
```

## Decision 4 — the schema changes, and the mixed-version story improves

`cursors` is a new table (`room`, `name`, `cursor`), replacing `agents.cursor`. The
legacy `agents` and `rooms` tables are **left in place and never dropped**.

**One-time import.** When `~/.morse/rooms/<room>/agents/` does not exist, the registry
imports any legacy `agents` rows for that room into files; the bus seeds `cursors` from
`agents.cursor` in the same pass. Read-only against the legacy tables.

The trigger has to sit in **whatever touches a room first — reads included — not in
`publish()`.** `publish()` creates that directory, so hanging the check off it works
for `morse join` and fails for `morse roster` and `morse log`, which only read. Those
would show an empty roster against a populated 0.2 room, which reads exactly like the
upgrade ate your history.

**Mixed versions on one machine behave better than under v1.** Previously `0.2` and
`0.3` would both write the shared `agents` table with different ideas about which
columns mattered. Now `0.3` simply stops reading it. The two still share `messages`
and `deliveries`, so **mail is still delivered between them** — only the roster
diverges, because a `0.2` agent publishes to a table a `0.3` agent no longer reads.
Visible and diagnosable rather than corrupting. Document it as: finish the session
before upgrading.

## Decision 5 — `Store` is a breaking change for library consumers only

You cannot move half a class into another package and still export one of it, short of
a delegating facade costing more than the split.

| Surface | 0.3.0 |
| --- | --- |
| `morse` CLI — every existing command, flag, env var | unchanged; verbs **added** (Decision 6) |
| MCP tool names, schemas, return shapes | unchanged |
| Role files, plugin manifests, discovery order | unchanged |
| Message delivery semantics | unchanged |
| `~/.morse/morse.db` | `cursors` added; legacy tables untouched |
| Agent records | move from SQLite to files, imported once |
| `import { Store } from "morse-ai"` | → `Bus` + `FileRegistry` |

Three published versions and a library surface almost nobody imports makes this the
honest call. `morse-ai` still re-exports everything else, so `buildPrompt`,
`loadRole`, `parseToml`, `waitForInbox` and friends keep working unchanged.

---

## Decision 6 — every package ships a CLI; MCP stays one composed server

*This replaces v3's open question, and resolves it: a per-package **CLI** does not
require the MCP transport to be shared, so `mcp/rpc.ts` stays in `morse-ai` and no
fourth package appears.*

**MCP is one server with all ten tools, composed in `morse-ai`.** Not per package: an
agent needs all ten to follow the loop in `prompt.ts`, and a bus-only server handing
out seven tools with no roster and no status would be a worse product than no server.
Each sub-package exports a plain `{ tools, handle }` object; `morse-ai`'s composer
declares the parameter type. TypeScript is structurally typed, so neither sub-package
imports a shared type and neither gains a dependency.

**Every package also ships a CLI, and the three have different jobs.** They are not
three copies of the same surface:

| `bin` | Audience | Output | What it is for |
| --- | --- | --- | --- |
| `morse` | humans, and agents without MCP | coloured; `--json` available | the product: `join`, composed views, the full agent verb set |
| `morse-bus` | machines and debugging | JSON by default | drive or inspect the log with no registry in the picture |
| `morse-registry` | machines and debugging | JSON by default | drive or inspect the directory with no bus in the picture |

The sub-package CLIs earn their place by being the **executable form of each package's
contract**. `morse-bus send` working in a directory where only `@morse-ai/bus` is installed
is a demonstration of the zero-dependency claim, not an assertion of it — and that is
exactly what CI runs (see [CI](#repo-build-tests-release)). They are also how you
bisect a problem: if `morse-registry list` is right and `morse roster` is wrong, the
bug is in composition.

> **The registry CLI can write, and that makes single-writer a convention rather than a
> property.** Decision 1's audit — every agent record has exactly one writer — is what
> justifies files over a database, and it holds for the *running system*: an agent only
> ever writes its own record. `morse-registry publish backend --role ...` breaks that on
> purpose, because a standalone-registry user needs some way to populate one.
>
> The consequence is bounded and worth naming rather than discovering. Records are
> written whole, by temp+rename, so a concurrent write can never corrupt or tear one —
> it can only lose the other writer's version entirely. Note that this *is* a change
> from today: `store.ts:112` merges field-by-field with `COALESCE(?, role)`, so two
> concurrent SQL registrations interleave per column where two concurrent file writes
> will not. Under the single-writer discipline neither case arises; the write verbs are
> the one place a user can opt out of it, and the docs should say so where they are
> documented.

**Shared CLI code is deliberately not extracted.** `parseArgs` is ~45 lines and
`cli/format.ts` is 109; a fourth package holding them would be the one thing
reintroducing a common dependency and would break the guard in Decision 3. Instead the
sub-package CLIs are JSON-only and need almost no formatting, so only the small arg
parser is duplicated — and each CLI's flag set differs anyway.

### How the bus CLI gets a registry

The library makes `registry` a required constructor argument so that running without
one is chosen rather than defaulted into. The CLI mirrors that exactly:

```
--registry <specifier>   load this module
(default)                use @morse-ai/registry if it resolves
--no-registry            run unregistered, on purpose
```

If none of the three applies it **errors** rather than silently degrading, and it always
prints what it resolved to stderr — `registry: @morse-ai/registry@0.3.0`, or
`registry: none — no presence, no recipient warnings`. Optional resolution at runtime
is not a `dependencies` entry, so the zero-dependency guard still passes.

### The agent verb set on `morse`

Seven of the ten tools have no CLI equivalent today. `send` and `ask` already exist —
and `morse ask` already blocks in `waitForReply` for up to 120s from an ephemeral
process (`cli/main.ts:507`), which is the proof that the whole approach works.

| Add | Mirrors |
| --- | --- |
| `morse wait [--thread <id>] [--timeout <s>]` | `morse_wait` |
| `morse inbox` | `morse_inbox` |
| `morse reply <thread> <body>` | `morse_reply` |
| `morse thread <id>`, `morse history` | `morse_thread`, `morse_history` |
| `morse register`, `morse leave` | `morse_register`, plus MCP's shutdown hook |
| `morse status set <state> [--note ...]` | `morse_status` |

`morse status` already means "one-line summary of the room", so the write form is a
subcommand — the shape `morse roles new <name>` already uses. Plus `--json` on every
read verb, and `--as <name>` with `MORSE_AGENT` winning when both are present, which
preserves the identity rule the MCP server enforces at `server.ts:48`.

Two more pieces make the CLI transport actually usable by an agent:

- **`prompt.ts` forks.** `buildPrompt({ transport: "cli" | "mcp" })`. A CLI-driven
  agent needs a prompt naming shell commands, and it needs to carry more weight —
  `mcp/tools.ts` calls its descriptions "the protocol documentation the model actually
  reads", and a CLI has no equivalent. Expect this prompt to be longer than the MCP one,
  not shorter.
- **`morse join --transport cli`** launches a harness with the CLI prompt and no
  `--mcp-config`, which is also the simplest path for a harness `buildHarnessArgs` does
  not know how to wire.

### The one place "just a second adapter" is not quite true

`morse_ask` returns early when *unrelated* mail arrives — that is the deadlock
avoidance, and by then `inbox()` has already advanced the cursor past everything it
drained. `wait.ts` is explicit about why it must drain the whole batch: "bailing out
mid-batch on the reply would silently drop anything ordered after it — unread, and now
unreachable."

Inside an MCP call that is safe: the handler returns `reply` **and** `inbox` in one
structured payload the harness always puts in front of the model, with a `hint` telling
it to handle that mail and then resume with `morse_wait --thread`. From a CLI, the same
payload is text on stdout that the agent may skim — and if it does, those messages are
consumed and unreachable. That is precisely the failure the drain logic exists to
prevent, reintroduced by the transport.

Today's `morse ask` already prints `result.inbox` (`cli/main.ts:514`) but formats it
like any other output and exits 1 for both `interrupted` and `timeout`, so nothing
distinguishes "your question is unanswered *and* you now own three messages" from
"nobody replied." Phase 5 owes three things here:

- **`--json` carrying `outcome` and `inbox` structurally**, so consuming the mail is a
  parse rather than a reading-comprehension exercise.
- **Distinct exit codes** — 0 replied, 2 interrupted, 1 timed out — so a shell loop can
  branch without parsing at all.
- **The `hint` text carried into the payload.** It already exists
  (`server.ts:316`), it is already load-bearing, and it is the sentence that tells an
  agent what to do next.

### One thing the CLI transport breaks, and the fix

`isRunning(pid)` is what separates "running, not listening" from "crashed"
(`store.ts:435`, rendered at `server.ts:364`). Under MCP the recorded pid is a
long-lived server. Under the CLI every command is ephemeral, so the pid is dead the
moment it exits and `alive` is always false.

The fix is to record the **harness's** pid rather than the caller's — `morse join`
already has `child.pid`. It is an improvement for MCP too, since it stops liveness
being tied to the MCP server's lifetime specifically. Phase 2 must not hard-code the
assumption that `pid` is `process.pid`.

**`morse-ai` cannot be a pure wrapper.** The composed MCP server, `prompt.ts` — which
documents all ten tools in one voice — and the agent verb set are inherently
cross-cutting. It is the product; the other two are libraries under it that happen to
be independently operable.

---

## Where every file goes

| File | Lines | Destination | Note |
| --- | --- | --- | --- |
| `roles.ts` | 513 | registry | `@morse-ai/registry/discovery` |
| `plugins.ts` | 273 | registry | `@morse-ai/registry/discovery` |
| `toml.ts` | 156 | registry | internal to discovery |
| `room.ts` | 35 | registry | the room name is now a path component — see below |
| **`store.ts`** | **468** | **split** | see below |
| `db.ts` | 196 | bus | the bus owns SQLite outright |
| `warnings.ts` | 17 | bus | guards `node:sqlite`; imported by `db.ts` itself |
| `wait.ts` | 108 | bus | `store.touch` → `registry.heartbeat` |
| `mcp/tools.ts` | 130 | split | 2 to registry, 7 to the bus, 1 to morse-ai |
| `mcp/rpc.ts` | 179 | morse-ai | settled by Decision 6 — stays put |
| `mcp/server.ts` | 381 | morse-ai | becomes a composer |
| `prompt.ts` | 77 | morse-ai | forks into MCP and CLI variants |
| `cli/main.ts`, `cli/format.ts`, `cli.ts` | 782 | morse-ai | gains the agent verb set |
| `version.ts` | 13 | ×3 | 13 lines reading its own package.json; duplicate it |
| `index.ts` | 47 | ×3 | morse-ai re-exports both |
| **new** `cli.ts` + `parseArgs` | ~120 ea. | bus, registry | JSON-only CLIs; the arg parser is duplicated on purpose |

**`store.ts` →**

- **registry, `FileRegistry`** — *reimplemented on files, not moved:* `publish`, `get`,
  `list`, `heartbeat`, `names`, `setStatus`, `depart`, `forgetRoom`, `listRooms`; the
  `toAgent` derivation (`online`, `alive`, `isRunning`, `parseSkills`); `Agent`,
  `AgentStatus`, `ONLINE_WINDOW_MS`.
- **bus, `Bus`** — *moved:* `send`, `insert`, `hydrate`, `systemMessage`,
  `unknownRecipients`, `inbox`, `unreadCount`, `thread`, `history`, `findReply`,
  `lastOwnMessageId`, `lastSpeaker`, `maxMessageId`, `clearMessages`, `join`;
  `normalizeRecipients`, `newThreadId`, `BROADCAST`, `Message`, `MessageKind`.

> **`join()` must not reseed `cursors` for a returning agent.** Today the UPDATE path
> of `register()` deliberately omits `cursor` (`store.ts:112–136`) — that omission is
> the entire mechanism behind *"re-registering keeps the cursor so nothing is lost
> across a reconnect"* (test line 89). Seed **only** when no `cursors` row exists,
> which is the same condition that decides whether to announce the join.

**Tool contributions**

| Tool | Contributed by |
| --- | --- |
| `morse_roster`, `morse_status` | registry |
| `morse_send`, `morse_ask`, `morse_reply`, `morse_wait`, `morse_inbox`, `morse_thread`, `morse_history` | bus |
| `morse_register` | **morse-ai** |

`morse_register` moves up to `morse-ai` because it is inherently both halves —
`registry.publish()` then `bus.join()` — and neither sub-package can own it without
depending on the other. That also removes the naming friction v2 had, where the
registration tool lived in the bus package. The composed server keeps one shared
session (`{ room, identity }`), which morse-ai owns.

`morse roster` composes the registry's roster with the bus's `unreadCount`; `morse rooms`
composes both; `morse reset` becomes `bus.clearMessages()` then
`registry.forgetRoom()`.

---

## Repo, build, tests, release

**Layout** — one repo, npm workspaces, `packages/{morse-ai,bus,registry}`,
a `tsconfig.base.json` holding the current compilerOptions and a solution
`tsconfig.json` with references. `examples/roles/` and a cross-package `test/` stay at
the root.

**Build** — TypeScript **project references** with `tsc --build`. Note the graph is now
flatter than v2: bus and registry are siblings with no edge between them, so only
`morse-ai` has references.

**Tests**

- **registry:** `roles`, `plugins`, `plugins-optout`, `codex-toml`,
  `rejection-reporting`, `role-containment`, plus `store.test.js`'s
  capability/status/presence cases — lines 25 and 228–282.
- **bus:** `store.test.js`'s delivery, cursor, thread and wait cases — lines 45–125
  and 143–209 — plus the two `join()` cases at lines 78 and 89. Both are about joining,
  not registering; do not let them get filed under registry on the strength of the word
  "registering".

  The bus's suite runs against a **stub registry, and the stub must carry exactly the four
  port methods and nothing else** — `unregistered` plus call recording. That exactness
  is the whole assertion: anything the bus reaches for beyond the port throws
  `TypeError: ... is not a function` at the call site, which is the failure you want. A
  permissive stub with a spare `get()` or `list()` on it "just in case" passes while
  proving nothing, so the test is worthless the moment someone adds a fifth key. Assert
  the key set directly.
- **morse-ai:** the conformance line from Decision 3, plus composition.
- **root `test/`:** `mcp`, `six-agents`, `security` — these spawn the real binary over
  real stdio and are inherently cross-package.
- **each CLI:** a smoke test per `bin` — `--help` exits 0, one round trip in JSON.

The registry's cases are the **acceptance criteria for the reimplementation**. They
assert behaviour, not storage, so they should pass unchanged against files. If one
needs editing to go green, that edit is the thing to review hardest in the project.

**The acceptance test for Decision 6 already exists in the right shape.** `six-agents`
starts six independent processes that discover each other, route by capability, answer,
and converge on `done`. Run it a second time over the **CLI transport** — same
scenario, same assertions, `morse join --transport cli`. Two harnesses of the same
protocol converging identically is the only evidence that will actually mean anything
about the CLI being a real transport rather than a set of verbs that happen to exist.

`test/helpers/client.js:5` hardcodes `../../dist/cli.js` → `packages/morse-ai/dist/cli.js`.

**CI** — six guards, all cheap, each protecting a decision that would otherwise decay:

1. **Stranded suites.** The existing `find test -mindepth 2 -name '*.test.js'` guard
   breaks the moment `packages/*/test/` exists. Extend it to cover the root and each
   package, keeping its intent: a suite no glob reaches is invisible, and invisible is
   not the same as failing.
2. **No roles ship.** The existing `npm pack --dry-run` + `grep -rqiE 'Product
   Owner|SecOps'` check, run for all three.
3. **New — the registry must not load a database.**
   `grep -rq "node:sqlite" packages/registry/dist/ && exit 1`. Decision 1 is the
   basis for the whole design; without a guard it decays the first time someone reaches
   for a query.
4. **New — both sub-packages must have zero dependencies.** Assert
   `dependencies` is empty in `packages/bus/package.json` and
   `packages/registry/package.json`. This is Decision 3 made mechanical: the day someone
   adds `"@morse-ai/registry"` to the bus's dependencies, the inversion is gone and nothing
   else would notice.
5. **New — each sub-package must work when it is the only thing installed.**
   `npm pack` it, install the tarball alone into a temp directory, and run a real round
   trip: `morse-bus send` / `morse-bus inbox --no-registry`, and `morse-registry publish`
   / `morse-registry list`. This is guard 4's claim actually executed rather than
   asserted, and it is the only one that catches a dependency smuggled in through a bare
   `import` that npm never sees.
6. **New — every package declares a working `bin`.** Each `bin` resolves, is
   executable, and `--help` exits 0. Catches the packaging mistakes that are invisible
   until someone installs: a missing shebang, a lost `chmod` (the current build does it
   in a `node -e` one-liner), a `files` array that omits the entry point.

**Versioning** — **permanent lockstep**, not just for this release. All three packages
always carry the same version and always publish together, even when a release touches
only one of them; a version that exists for one package exists for all three. That is a
standing rule, so the release workflow should verify it (all three `package.json`
versions equal the tag) rather than trusting the bump to have been done by hand.

All three go to `0.3.0`; `morse-ai` pins the others
**exactly**, so a published `morse-ai` can only resolve versions it was tested against.
One `v0.3.0` tag, publishing in dependency order — **bus and registry in either
order, then morse-ai**, since they no longer depend on each other. That order is
irreversible: if morse-ai fails after the others publish, those versions exist and
cannot be republished. Recovery is a patch bump of all three, and the workflow comment
should say so rather than leaving the next person to find out at the worst moment.

---

## Sequencing

Eight phases, all inside `0.3.0`. Each ends with the full suite green and a hand-run
`morse join` — see [What only fails at runtime](#what-only-fails-at-runtime).

| Phase | What | Risk |
| --- | --- | --- |
| 0 | Workspaces skeleton, project references, root scripts. **No code moves, nothing published.** | none |
| 1 | registry, discovery only: `roles`, `plugins`, `toml`, `room`. Pure code motion. | low |
| 2 | **`FileRegistry`, reimplemented on files** + the one-time import + the `sanitizeRoom` fix. `Store` loses its agent half. | **high — alone in its own phase** |
| 3 | bus: the `Bus` half, `db.ts`, `warnings.ts`, `wait.ts`, the `cursors` table, **and the `Registry` port**. Suite runs against a stub. | medium |
| 4 | Split the MCP tool sets; `mcp/server.ts` becomes a composer and owns `morse_register`. | low |
| 5 | **`morse` agent verb set**: `wait`, `inbox`, `reply`, `thread`, `history`, `register`, `leave`, `status set`; `--json`, `--as`; the CLI `prompt.ts` variant; `join --transport cli`; the harness-pid fix. | medium |
| 6 | **`morse-bus` and `morse-registry` CLIs** + registry resolution (`--registry` / `--no-registry`) + the isolated-install guard. | low |
| 7 | CI guards, release workflow, README / CONTRIBUTING / SECURITY. Then the two **human-only** steps: first manual publish of each new package, and configuring its trusted publisher. Tag `0.3.0`. | — |

**Phases 0–6 are entirely local.** No registry calls, no credentials, no external
service — the org already reserved both names, so nothing needs claiming before the
code is ready. Everything that requires a human account is now inside Phase 7.

Phase 0 is worth doing alone even if the rest slips: it proves workspaces, project
references and the existing suite coexist while `git diff` is still readable.

Phase 2 is the one to be careful in — the only phase that changes behaviour's
*substrate* rather than its location, and the only one where a green suite is genuinely
informative. Everywhere else, green mostly means "the imports resolve."

Phase 3 is where the port lands, and running the bus's suite against an exactly-four-key
stub is the design's own test: if the bus reaches for a fifth method, the call throws
rather than quietly widening the contract.

Phase 5 is the substantial one after Phase 2, and it is substantial for a reason that
is not code volume: the CLI prompt has to do work the MCP tool descriptions were doing
for free. Budget for iterating on that prompt against the `six-agents` scenario rather
than treating it as documentation to be written once.

Phase 6 is small precisely because Phase 5 did the thinking — the sub-package CLIs are
thin JSON wrappers over surfaces that already exist.

**Settled: all eight phases ship as `0.3.0`.** There is no intermediate release. If it
drags, it drags — Phases 5 and 6 add surface without changing anything below them, so
the split never has to be redone, but the release line stays at the end.

## What only fails at runtime

- **`sanitizeRoom` does not block `..`, and Phase 2 makes that matter.** Verified:
  `sanitizeRoom("..")` → `".."`, as do `"  ..  "` and `"-..-"`. Slashes are stripped so
  multi-segment traversal is already blocked (`"../.."` → `"..-.."`), but a bare `..`
  survives. Harmless today, because the room name only ever becomes a SQL value.
  Under a file-backed registry it becomes a path component, so
  `MORSE_ROOM=.. morse roster` resolves to `~/.morse/rooms/../agents` — one level up,
  into `~/.morse` itself. Contained rather than catastrophic, but it is exactly the
  class of bug `isValidRoleName` already guards (`!name.includes("..")`), and the fix
  is one line in the same shape.
- **`cli/main.ts:151`** — `new URL("../cli.js", import.meta.url)`, the path handed to
  the spawned harness as its MCP server command. Depth-sensitive.
- **`cli/main.ts:527`** — the same resolution again, written into `.mcp.json` by
  `morse init`. Breaks silently for anyone who ran `init` before upgrading.
- **`version.ts:11`** — `require("../package.json")`. Correct in the repo *and* the
  tarball today because `dist/` sits one level under the package root. Verify that
  holds for all three under workspaces, where the repo has an extra level and the
  tarball does not.
- **Handshake version** — `serve({ name: "morse", version })`. Decide which package's
  `VERSION` the composed server reports; `morse --version` stays morse-ai's.
- **`npm pack` per package** — `files: ["dist", "README.md", "LICENSE"]`. Each needs its
  own README and LICENSE or npm publishes three pages of nothing.
- **Three `bin` entries, three chances to ship something unexecutable.** The current
  build chmods `dist/cli.js` in a `node -e` one-liner bolted onto `build`; that has to
  happen for all three now, each entry point needs its own shebang, and `files` has to
  include it. None of this fails at compile time and all of it fails at
  `npm i -g`. Guard 6 exists for exactly this.
- **`morse status` already means something.** Adding the write form as `morse status
  set <state>` rather than a flag keeps the existing read behaviour intact; a
  `--set` flag on the same verb would be a silent behaviour change for anyone
  scripting the summary.
- **Directory permissions.** `db.ts` chmods the store to 0600 and `~/.morse` to 0700
  (`db.ts:172`) because everything agents say lands there in plaintext. Agent records
  are the same class of data and now live in files — `~/.morse/rooms/**` needs the same
  treatment, and SECURITY.md needs a line saying so.

## Publishing, which now happens at the end

The `morse-ai` org reserves `@morse-ai/*` permanently, so **nothing has to be published
before the code is ready**. What the org does *not* remove is the trusted-publishing
bootstrap: OIDC is configured [per package, on that package's settings
page](https://docs.npmjs.com/trusted-publishers), which only exists once the package
does. So each new package still needs one manual publish — it just happens in Phase 7,
racing nobody.

**The rule that shapes the procedure:** npm never lets a version be reused. ["Once
`package@version` has been used, you can never use it again. You must publish a new
version even if you unpublished the old one."](https://docs.npmjs.com/policies/unpublish)
So the bootstrap publish **must not be `0.3.0`**, or the real release can never have
that number.

In Phase 7, for `@morse-ai/bus` and then `@morse-ai/registry`:

1. Set `version: "0.0.0"` temporarily, with `publishConfig.access: "public"` —
   **mandatory for scoped packages**, which default to restricted, and restricted fails
   on a free org — and `repository.url` matching `https://github.com/CodyEngel/morse`.
   [Provenance requires that field to match the publishing source,
   case-sensitively](https://docs.npmjs.com/generating-provenance-statements); verified
   consistent today across `package.json`, `git remote`, and GitHub: `CodyEngel/morse`.
2. `npm login`, then `npm publish --access public --tag reserved`. `--tag` keeps
   `latest` off the stub; if it lands there anyway it self-heals, because an untagged
   publish at `0.3.0` always moves `latest`.
3. npmjs.com → the package → Settings → Trusted Publisher → GitHub Actions:
   org `CodyEngel`, repo `morse`, workflow `release.yml`.
4. Restore `version` to `0.3.0` in all three packages and tag `v0.3.0`. CI publishes
   all three with provenance.

Local npm is 11.11.0, well past the 9.5.0 provenance floor.

Steps 2 and 3 are the **only** two things in this plan that cannot be done from the
repository — one needs an interactive login, the other is a web UI.

Two things to know:

- **`0.0.0` is burned permanently** for both packages. That is the whole cost of
  keeping provenance on `0.3.0`. Skipping it means publishing `0.3.0` by hand instead,
  unprovenanced, with CI taking over at `0.4.0` — cheaper now, worse attestation
  forever.
- **One trusted publisher per package**, and it names the workflow file. Renaming
  `release.yml` later means reconfiguring all three.

**Settled, no longer open:**

- Decision 5 — `Store` breaking for library consumers is accepted; pre-1.0, no known
  consumers.
- All eight phases ship as a single `0.3.0`. See [Sequencing](#sequencing).
- Versions stay in lockstep permanently — all three release together at the same
  number, `morse-ai` pinning the other two exactly. The `0.0.0` placeholders sit
  outside that sequence; lockstep begins at `0.3.0`, which is also `morse-ai`'s next
  number anyway.
- v3's open question — whether the sub-packages needed their own MCP servers — is
  settled by Decision 6: they get CLIs instead, which need no shared transport, so
  `mcp/rpc.ts` stays in `morse-ai` and there is no fourth package.

---

### Footnote: an incidental win

`cli/main.ts` imports `Store` at module scope, so `db.ts` runs
`createRequire(...)("node:sqlite")` on **every** command — including `morse roles` and
`morse prompt`, which never touch the database. If `morse-ai` defers its bus import,
those commands stop loading a storage engine altogether. Not a decision, just something
the split makes available.
