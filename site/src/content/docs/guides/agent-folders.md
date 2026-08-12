---
title: Agent folders other tools keep
description: Morse borrows agent definitions from .claude/agents, .codex/agents and .pi — which fields it takes, what it refuses, and how to teach it a fourth ecosystem.
sidebar:
  order: 2
---

You have probably written these definitions once already. Morse reads the agent
folders your other tooling keeps, so a populated `.claude/agents/` needs no
copying:

```
.claude/agents/backend.md        →  morse join backend
.codex/agents/backend.toml       →  morse join backend
```

Each rung of the [lookup ladder](/guides/roles/#where-morse-looks) is widened
with those folders, and `.morse/roles` still wins at the same rung — writing the
morse file is how you say "I mean this one". `$MORSE_ROLES` is not widened;
packs stay morse-shaped.

## The built-in plugins

| Plugin | Project | Personal | Layout |
| --- | --- | --- | --- |
| `claude` | `.claude/agents` | `~/.claude/agents` | `<name>.md` |
| `codex` | `.codex/agents` | `~/.codex/agents` | `<name>.toml` |
| `pi` | `.pi/agent/agents`, `.pi/agents` | `~/.pi/agent/agents` | `<pack>/<name>.md` |

pi's project-local convention is unconfirmed, so both plausible directories are
searched. A directory that is not there is the normal case, not an error —
`morse roles` lists it as `(absent)` rather than staying quiet about it.

## Only two fields are borrowed

Only `name` and `description` are taken, plus Codex's `developer_instructions`
as the guidance body.

A `tools:` list, a `sandbox_mode` or a `model` is a permission, not a capability
blurb, so none of them are mapped onto morse `skills`. Agents pick teammates by
reading skills, and a borrowed role arriving with none is honest about what its
source file actually said. Write a `.morse/roles/<name>.md` when you want that
agent to advertise skills.

## The TOML reader refuses rather than guesses

Codex files are TOML, which morse reads with a deliberately small reader:

- `key = "value"`
- `key = """multi-line"""`
- comments

Anything else — tables, dotted keys, arrays, `'''` literals — **refuses the
whole file** rather than guessing. A prompt body silently truncated at the first
`"""` is worse than no role at all, because nothing looks wrong.

A refused file is reported with its reason by `morse roles`, and by `morse join`
when you asked for that role by name.

## Teaching morse a fourth ecosystem

It is a JSON file, not a patch. Drop it in `.morse/plugins/` (or
`~/.morse/plugins/`):

```json
{ "id": "acme", "project": [".acme/agents"], "depth": 0, "map": { "description": "summary" } }
```

A plugin is a manifest, never code — morse reads config files, it does not run
them. Reusing an `id` replaces that plugin, which is how you correct a built-in
without waiting for a release; when a manifest inside the project does that,
`morse roles` says so, because it may have arrived with a clone.

Manifests are read from `.morse/plugins/*.json` in a project and
`plugins/*.json` under `$MORSE_HOME`. One that does not parse is skipped rather
than fatal.

| Field | Default | Meaning |
| --- | --- | --- |
| `id` | required | Names the plugin in `morse roles` output. Lowercase letters, digits, dot, dash, underscore. |
| `project` | none | Directories to search, relative to a project root (the current directory, the git root). |
| `personal` | none | Directories to search, relative to your home directory. |
| `depth` | `0` | Levels below each directory to descend. Flat layouts are `0`; pi's `agents/<pack>/<name>.md` is `1`. |
| `extensions` | `[".md", ".markdown"]` | Which files are agent definitions. |
| `format` | `"frontmatter"` | How a file is read: `frontmatter` or `toml`. |
| `map` | `{}` | Which key in that ecosystem supplies each morse field — any of `name`, `role`, `description`, `skills`, `brief`. Anything left out is absent rather than guessed. |

`brief` is the guidance body, and is only consulted for formats with no document
body of their own — a markdown file's body is its brief. A directory that
contains `..` or starts with `/` rejects the manifest: a manifest directory is
joined onto a search root, and it must not be able to climb out of one.

## Auditing what morse found

```bash
morse roles                  # every definition, labelled with the plugin that supplied it
morse roles --no-plugins     # only .morse/roles
```

`morse roles` labels every borrowed definition with the plugin that supplied it
and lists every directory searched, including the ones that were absent. To turn
discovery off and get pre-plugin behaviour exactly, pass `--no-plugins` or set
`MORSE_PLUGINS=off`.

:::caution
A file you wrote for another tool can now instruct a morse agent — cloning a
repository with a `.claude/agents/` directory is enough, and nothing needs
copying into `.morse/roles`. Review those directories on the same terms as a
role file. See [Security and
data](/security/#morse-reads-files-you-wrote-for-other-tools).
:::
