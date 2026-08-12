# 0.4.0 — cutting the protocol tax

Status: **implemented; on the working tree awaiting commit and npm release.**
Kept as the record of why, with
[what the building changed](#what-the-building-changed) noting where the result
differs from the plan.

Morse's job is to let agents coordinate, and every token and turn it spends on
*coordination mechanics* is taken from the work itself. 0.3.0 got the semantics
right — delivery, presence, convergence. 0.4.0 makes being in the room cheap.

Companion files, all beside this one or in `scripts/`:

| File | What it holds |
| --- | --- |
| `scripts/measure-protocol.mjs` | Reruns every number below against the built tree |
| `baseline.json` | The raw 0.3.x run, captured before the first change landed |
| `results.json` | The raw 0.4.0 run |

## Results

| Cost | 0.3.x | 0.4.0 target | 0.4.0 measured |
| --- | --- | --- | --- |
| Tool calls from launch to first park (empty room) | 3–4 | **1** | **1** (register; 2,023 B → 756 B including the park's return) |
| Turns per idle hour (Claude Code defaults) | ~72 | **≤ 14** | **~13**, ~98 tokens/hour (was ~6,860) — steady-state empty wait is 30 B |
| Protocol tokens per exchange (envelope, not bodies) | baseline | **−30% or better** | **−71%** overhead on the busy-exchange scenario (12,161 B → 3,549 B) |
| Turns for a working agent to learn a newcomer's skills | unbounded (often never) | **0 extra** (rides the next tool result) | **0 extra**, pinned by test |
| Message delivery latency | ~200 ms | unchanged | ~200 ms; ≤ 1 s once parked past 5 s (Decision 2's poll backoff), pinned by test |

"Protocol tokens" means everything morse adds around user content: envelopes,
rosters, hints, indentation. Three levers carried most of the drop: results
stopped echoing what the model just wrote, coaching is said once per session
instead of per call, and the steady state of an idle room became deltas that
are omitted when nothing changed. TOON supplies the last slice, and only in
combination with the envelope diet — see
[what the numbers taught](#what-the-numbers-taught).

## The problem: what 0.3.x cost

Measured on 0.3.x before the first change (the baseline file holds the raw
run):

1. **Cold start was 3–4 turns.** The opening turn (`cli/main.ts`,
   `OPENING_TURN`) instructed register → roster → inbox → wait. But the MCP
   server already registered the agent at startup (`mcp/server.ts`
   `registerSelf`), and `morse_register` already returned the full roster — so
   the roster call re-fetched what the model was just handed, and inbox was a
   third turn that returned `[]` in a fresh room. Each of those was a full
   harness round trip.
2. **An idle agent burned ~72 turns an hour.** The default park was 50 seconds.
   Every empty timeout is a complete model turn — inference over the whole
   accumulated context — whose only output is "call `morse_wait` again", plus
   ~150–200 tokens of identical `room_status` and hint text appended to the
   context each cycle.
3. **Every exchange carried dead weight.** Tool results were pretty-printed
   JSON (`rpc.ts` `toToolResult`, 2-space indent). `morse_send` and
   `morse_reply` echoed back the full body the model just wrote; `morse_ask`
   echoed the question. The same coaching hints rode on every response for the
   life of the session.
4. **A late joiner was invisible.** A join is a system message with no delivery
   rows — deliberately, so presence churn never interrupts a blocking ask. But
   the only trace existing agents ever saw was `{name, status, online}` in an
   empty-wait result, with nothing marking the name as new and no capabilities
   attached. Mid-work agents routed to a newcomer only by accident.
5. **The first arrival could talk itself into leaving.** In a room of one,
   `morse_status`'s convergence check answered "Everyone online is done. If
   nothing is addressed to you, you can stop." — vacuously true before any work
   ever arrived. An agent joined ahead of instructions could faithfully
   conclude it should exit.

What this release is **not**: a new transport, a daemon, or a push system. The
turn-based thesis stands — agents hear things by parking on purpose. Every
change below is about making the parking, and everything around it, cost less.

## Decision 1 — register is the check-in, and the only opening call

`morse_register` becomes the one call that starts a session: it already
publishes identity and returns the roster; it now also drains the inbox.

- Response gains `messages: [...]` — whatever was waiting, delivered under the
  same rule as everywhere else (returned = cursor advanced = read).
- When the agent is alone, the response carries a notice: *"You are the first
  one here. Teammates and instructions arrive over morse — park with
  `morse_wait` and stay parked."* The confusion this release is chasing starts
  at that exact moment; one conditional line ends it.
- `OPENING_TURN` shrinks to: register, handle what came back, then wait. And it
  becomes **transport-aware**: the same constant used to be sent for
  `--transport cli` sessions, telling them to call MCP tools they do not have.
  It moves next to `VERBS` in `prompt.ts`, which already knows both spellings.
- The prompt gains two lines: being first is normal (park, don't improvise),
  and a role-less agent should register bare and re-register with a real
  description after its first task arrives — not invent expertise in an empty
  room.
- The done-trap closes: the server (one long-lived process per agent) tracks
  whether this session has *ever* received work — first message delivered, or
  first `working` status. Until then, `morse_status` and empty-wait hints never
  suggest stopping; they say to keep parking. "Never had a task" and "finished
  my task" stop sharing a hint.

## Decision 2 — waits sized to the harness

The 50-second default exists to stay inside strict harnesses' MCP timeouts.
Claude Code's is effectively unbounded, and `morse join` already knows which
harness it is launching — so the launcher, not the agent, picks the park:

- `morse join` writes `MORSE_WAIT_SECONDS` into the server env explicitly:
  270 for Claude Code, 50 for Codex and unknown harnesses. (Explicit beats
  inheritance: the Codex TOML env is constructed by hand already, and relying
  on shell inheritance for claude is an accident that happens to work.)
- `MAX_WAIT_SECONDS` (900) becomes env-tunable the same way, so a claude
  session can park past 15 minutes if the operator wants.
- The prompt tells agents to pass a long `timeout_seconds` themselves when
  parking with nothing outstanding — zero code, immediate effect.
- Poll backoff inside the park: 200 ms for the first ~5 s, then 1 s. Cuts
  steady-state DB polls and heartbeats ~5× per parked agent; worst-case added
  delivery latency is 800 ms on an agent already idle for seconds.

**Latency is unaffected by longer parks.** Mail breaks the poll within one
interval regardless of the timeout; the timeout only sets how often an *empty*
wait costs a turn. And a parked call does not lock the human out: cancellation
propagates (`rpc.ts` handles `notifications/cancelled`, the wait loop honours
the abort signal), so Esc interrupts a park immediately.

**Why 270 s:** just under the 5-minute prompt-cache TTL, so each re-park turn
finds the cache warm — ~13 turns per idle hour at cache-read prices, versus ~4
cache-cold turns at 900 s. For API-billed sessions with real context behind
them the warm cache wins the arithmetic; subscription sessions mostly care
about turn count, where 270 s is still a ~5× improvement. The tunable cap makes
900+ a choice for anyone whose billing says otherwise.

## Decision 3 — the roster delta rides the next result

Late-joiner discovery, without new messages and without waking anyone.

The MCP server is per-agent and long-lived, so it remembers the roster as last
shown to *this* session — through any tool result that carried one (register,
roster, an ask that named nobody). Whenever a tool result goes back to the
model, the server diffs the live roster against that memory:

- `arrived: [...]` — full entries (role, description, skills) for agents this
  session has not been shown. Capabilities, not just a name: the point is that
  a working agent can route to the newcomer without spending a turn on
  `morse_roster`.
- `departed: [...]` — names that left. Names only; there is nothing to route to.
- Both keys are omitted when empty, which is almost always. The steady-state
  cost of this feature is zero tokens.

Wait returns are where the delta usually lands — an idle or blocked agent is
parked inside one, so a newcomer reaches it the moment its park next breaks.
But it rides *every* result, not just waits, because stale routing happens
elsewhere: an agent deep in its own work touches morse only to send, ask, or
set status, and the unknown-recipient warning catches a name that does not
exist — routing to the wrong *existing* agent fires nothing. The diff also
keys on a content hash of (name, role, description, skills) rather than bare
membership, so a teammate that re-registers with changed capabilities
surfaces the same way a newcomer does.

The join announcement in the room log also gains the newcomer's role —
`backend joined the room (Backend Engineer: sql, api-design)` — for humans
watching `morse log`. Delivery stays exactly as it is: to nobody. The rule that
presence churn never interrupts a blocking ask is load-bearing and untouched.

## Decision 4 — the payload diet

Everything a model reads gets cheaper; everything scripts parse stays stable.

- **Compact JSON, everywhere JSON survives.** `toToolResult` drops the 2-space
  indent for the `MORSE_FORMAT=json` fallback (the model-surface default
  becomes TOON — Decision 5), and the CLI's `--json` goes compact too: same
  shape, same keys, fewer bytes; `jq` does not care. Indented JSON is ~20–40%
  more tokens for these shapes and buys a machine reader nothing.
- **No echoes.** `morse_send` / `morse_reply` return `{id, thread_id, to}` —
  the model composed the body one tool call ago. `morse_ask` drops the `asked`
  echo and keeps `outcome`, `thread_id`, `reply`, `inbox`.
- **Hints are said once.** The server tracks which hints this session has seen.
  First occurrence full, then omitted (or a short form where the situation
  genuinely recurs, like the interrupted-ask recovery). The two rules that must
  never be lost — a wait is a real block, an interrupted ask hands you mail
  already marked read — live in the system prompt, which is permanent context.
- **Trimmed model-facing renderers.** Per message: drop `subject`/`reply_to`
  when null, drop `to` when it is only the reader. Per roster entry on the MCP
  path: drop `harness`, `last_seen_seconds_ago`, `pid`-derived fields; keep
  name, role, description, skills, status, note, online — the routing signal.
- **The `--json` CLI contract does not change shape** in 0.4.0 — compacting is
  the only change it takes. It becomes purely the script-facing surface
  (shell-transport agents move to `--toon`, Decision 5). The MCP surface is
  read only by models, so it can be trimmed freely.

## Decision 5 — TOON where models read, JSON where scripts do

[TOON](https://github.com/toon-format/toon) (Token-Oriented Object Notation)
declares the fields of a uniform array once and then emits rows — exactly the
shape of morse's expensive payloads. A roster is a uniform array; an inbox, a
thread, a history are uniform arrays whose envelope keys (`id`, `thread_id`,
`from`, `to`, `kind`, `at`) repeat on every message otherwise. Where data is a
single nested object (a register response, an ask result), TOON is roughly at
parity with compact JSON — so defaulting to it loses nothing on the small
payloads and wins on the tabular ones. It becomes the **default on every
surface only models read**; JSON stays one flag away, and scripts keep JSON
entirely. Morse's own numbers, not anyone else's benchmark, are the ones in
[Results](#results).

How it ships:

- **A vendored, encode-only writer.** Agents only ever *read* morse output —
  tool arguments arrive as JSON over MCP, CLI verbs take flags — so morse
  never parses TOON, only emits it. An encoder for the subset morse needs
  (scalars, flat objects, arrays of scalars, tabular arrays of uniform
  objects, list-form fallback for anything ragged, spec-correct quoting and
  escapes) is a couple hundred lines, written in-repo against a named spec
  version — the same call the registry made with its deliberately small TOML
  reader. Golden tests pin the output, and the reference `@toon-format/toon`
  decoder runs as a **dev-only** dependency that round-trips every golden back
  to the source object, so "follows the spec" is a tested property rather than
  a claim. The zero-runtime-dependencies claim holds.
- **Where it lives:** `morse-ai`, the product surface agents actually consume.
  The `morse-bus` / `morse-registry` sub-CLIs stay JSON-only in 0.4.0;
  duplicating the encoder into the zero-dep packages can wait for evidence
  anyone wants it there.
- **Defaults:** MCP tool results are TOON unless `MORSE_FORMAT=json` says
  otherwise — that surface has exactly one kind of reader, and it is the kind
  TOON is for. On the CLI, `--toon` joins `--json` on every read verb
  (`inbox`, `wait`, `roster`, `history`, `thread`, `ask`), and the
  CLI-transport prompt teaches `--toon` in its verb examples, so shell agents
  land on it too. Flagless CLI output stays human-formatted; `--json` stays
  JSON, because scripts parse it.
- **Never required** means one step back: `MORSE_FORMAT=json` restores the
  JSON family for any harness, model, or debugging session that wants it, and
  the README documents both formats with the measured savings side by side.

## How it was built

Five phases, ordered so the measurement stayed honest — the baseline was
captured from a clean 0.3.x checkout *before* the first change, and the same
scripted scenarios reran at the end:

| Phase | Contents | Touched |
| --- | --- | --- |
| 0 | Measurement harness, 0.3.x baseline | `scripts/measure-protocol.mjs`, test helpers |
| 1 | Payload diet (Decision 4) | `rpc.ts`, bus/registry `mcp.ts`, `server.ts` |
| 2 | One-turn join (Decision 1) | `server.ts`, `prompt.ts`, `cli/main.ts` |
| 3 | Harness-sized waits + roster delta (Decisions 2–3) | `cli/main.ts`, `server.ts`, `wait.ts`, `morse.ts` |
| 4 | TOON encoder + defaults (Decision 5) | new `toon.ts`, `rpc.ts`, `cli/agent.ts`, `cli/main.ts`, `prompt.ts` |
| 5 | Docs, README cost section, lockstep 0.4.0 | README, this file, three package.json |

Phases 0 and 4's encoder were built in parallel, in isolated worktrees, while
1–3 landed on the main tree; a completeness review then reconciled the diff
against this document, and what it found became the last round of fixes and
the deviations below.

The harness (`scripts/measure-protocol.mjs`) drives scripted sessions over the
real MCP server and records the exact `content[0].text` bytes a model reads,
per scenario: the 0.3.x opening sequence, the 0.4.0 opening sequence, a
two-agent working session, and the idle steady state. The suite grew from 118
to 138 tests; the new coverage pins the check-in, the first-arrival notice,
never-done-before-work gating, the delta (arrival, capability change, slim
status flip, departure, on-send, steady-state-empty), hints-once, the
transport-correct opening turns, TOON-as-default round-tripped through the
reference decoder, the encoder goldens, and post-backoff delivery latency.

Still pending at release time: the [Results](#results) table goes into the npm
release notes, with the `--json` contract note from the deviations below.

## Risks, revisited

How each risk called out in planning actually landed:

- **Long parks inside stricter harnesses** — held: defaults are per-harness,
  and nothing changed for Codex or unknown harnesses without an explicit env.
- **Hint suppression removes guidance a model needed later** — landed stricter
  than planned in the safe direction: recovery hints (`interrupted`,
  `timeout`) are exempt from the once-gate entirely, and the two load-bearing
  rules stay in the system prompt. The full suite, six-agents included, runs
  green under the gated hints.
- **TOON misreads** — the mitigation shifted from a per-result label (dropped,
  see deviations) to conformance: every encoding round-trips through the
  reference decoder in tests, and an end-to-end test decodes a
  default-configured server's actual output. `MORSE_FORMAT=json` remains the
  one-env-var rollback.
- **Broad test churn** — happened as budgeted: shape assertions were updated
  in one release, and the suite ended larger (138) and green.
- **The cache-TTL arithmetic varies by plan and configuration** — unchanged:
  the wait default is one env var, and the reasoning lives in Decision 2, not
  in code.

## Resolved questions

Settled 2026-08-11:

1. **Claude Code default park:** 270 s — the cache-warm arithmetic in
   Decision 2. The tunable cap covers anyone who wants 900+.
2. **TOON by default?** Yes, on the model-only surfaces. Vendoring the encoder
   removed the dependency cost that made this a maybe-later; `MORSE_FORMAT=json`
   is the way back.
3. **Compact `--json`?** Yes — same shape, no indentation, noted in the
   changelog.

## What the building changed

Where the implementation deviates from the decisions above, and why. Grouped
by who needs to know.

### Visible to a 0.3.x user — release-note material

- **`morse register` drains the inbox on every transport and format** — the
  check-in mechanic, and therefore the one deliberate break in the "`--json`
  shape unchanged" promise: the result gains `messages`, and the drain
  advances the cursor, so a script that runs `register --json` then
  `inbox --json` now sees the mail once, in the register result.
- **`--toon` on the CLI verbs uses the model-facing renderers** — brief roster
  (on `morse roster` too), viewer-trimmed mail (including `morse ask` results),
  no self-echo, and the empty `wait --toon` drops `room_status` exactly as MCP
  did — while `--json` keeps the 0.3.x shapes. Decision 4 promised `--json`
  stability and Decision 5 said "TOON where models read"; a CLI-transport
  agent reads `--toon`, so it gets the same diet the MCP surface gets. Without
  this, a shell agent's inbox never tabularized (the `to` array in every row
  disqualifies the tabular form).
- **`morse register` (CLI) now honours `MORSE_SKILLS`.** Role and description
  already fell back to the env `morse join` sets; skills did not — a latent
  0.3.x inconsistency with the MCP server that the end-to-end smoke test
  surfaced.
- **`morse status` and `morse rooms` also took `--toon`**, beyond the six read
  verbs the plan promised.

### Design details settled in the building

- **Status flips ride the delta slim.** Decision 3 hashed status into one
  capability diff; built that way, every ask/reply cycle (which flips the
  asker blocked→working) would have re-shipped a full capability blurb to the
  other side. The delta now diffs capabilities and status separately: a
  capability change sends the full brief, a status-only change sends
  `{name, status, note?}` (~30 B).
- **The empty wait dropped `room_status` entirely.** The plan trimmed it; the
  delta made it redundant — "backend went done" arrives as a `changed` entry
  exactly once, instead of a status block re-shipped every cycle. The
  steady-state empty wait is `{messages: [], waited_seconds}`.
- **Model-facing spellings differ from the plan's sketch.** The brief roster
  renderer publishes `expertise` (the registry's `description`), flattens
  `skills` to one space-joined string — which is what lets a roster row
  tabularize — and shows `presence` only for offline agents. send/reply answer
  `{sent: {id, thread_id, to}}`, the plan's fields one level down.
  `morse_status` stopped echoing the note it was just handed. The registry's
  `Agent` type gained the raw `present` flag, which is what departure
  detection reads.
- **Recovery hints stay whole.** The plan offered "a short form where the
  situation genuinely recurs"; as built, `interrupted` and `timeout` hints are
  exempt from the once-gate entirely — each carries a thread id the model
  needs verbatim, and shortening a recovery instruction to save bytes is the
  wrong trade.
- **No per-result `format: toon` label.** The risk section proposed one; a
  label on every result is precisely the per-exchange overhead this release
  exists to remove. The prompt's format notes (MCP and CLI) carry the
  teaching instead, once, and the end-to-end test holds the output to the
  reference decoder rather than to a label.
- **`OPENING_TURNS` lives in `cli/main.ts`** beside the launcher that sends
  it, not next to `VERBS` in `prompt.ts` as Decision 1 sketched — the
  transport-awareness is what mattered, and a test pins each transport's
  spelling.

### What the numbers taught

- **TOON's measured win is format-plus-diet, not format alone.** On uniform
  lists (rosters, drained inboxes) TOON beats compact JSON clearly; on small
  single-object results it roughly ties, and on ragged shapes (a broadcast's
  `to: ["*"]` forcing list form) it can lose by a few bytes. The encoder also
  deliberately omits keys for `undefined` values where the reference encoder
  writes `key: null` — morse distinguishes absence from null — with the
  reference *decoder* accepting both, which is the conformance bar the tests
  hold (see `toon.ts`'s header for the full accounting).
- **The measurement harness runs pinned to JSON and derives TOON** by
  re-encoding each parsed result with the same encoder the server uses —
  byte-identical to a TOON session, while keeping the script's flow control
  parseable.
