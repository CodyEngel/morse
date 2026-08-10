import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Morse is not the only tool on the machine that keeps agent definitions in a
 * folder. A plugin teaches it where another ecosystem keeps them and how to
 * read one, so a builder who already wrote `.claude/agents/backend.md` can run
 * `morse join backend` without copying the file into `.morse/roles`.
 *
 * A plugin is a manifest, never code. The body of a discovered file is appended
 * to an agent's system prompt (see SECURITY.md), so "morse reads a config file"
 * must not become "morse runs code from a cloned repository". Everything an
 * ecosystem differs by — where it looks, how deep, which extensions, which
 * frontmatter keys mean what — is data.
 *
 *   {
 *     "id": "acme",
 *     "project": [".acme/agents"],
 *     "map": { "description": "summary" }
 *   }
 */
export interface PluginManifest {
  /** Shown by `morse roles` so a borrowed definition names its origin. */
  id: string;
  /** Directories to search, relative to a project root (cwd, git root). */
  project?: string[];
  /** Directories to search, relative to the user's home directory. */
  personal?: string[];
  /**
   * How many directory levels below each entry above to descend. Claude keeps
   * agents flat (0); pi namespaces them by pack, `agents/<pack>/<name>.md` (1).
   */
  depth?: number;
  /** Which files are agent definitions. */
  extensions?: string[];
  /**
   * How the file is read. Discovery does not care: adding an ecosystem that
   * stores agents in some other format is a manifest and a reader, not a change
   * to the search itself.
   */
  format?: "frontmatter" | "toml";
  /**
   * Which key in that ecosystem's frontmatter supplies each morse field.
   * Anything left out is absent rather than guessed.
   *
   * Note what is deliberately missing from every built-in: `skills`. Claude and
   * pi carry a `tools:` list and Codex carries sandbox and model settings, but
   * those are permissions, not capability blurbs — and agents route work by
   * reading skills off the roster. A borrowed role arrives with no skills,
   * which is honest; `role` and `description` carry the signal.
   *
   * `brief` is only consulted for formats with no document body of their own.
   * A markdown file's body is its brief.
   */
  map?: Partial<Record<"name" | "role" | "description" | "skills" | "brief", string>>;
}

/** A directory a plugin contributed, and the plugin that contributed it. */
export interface PluginDir {
  plugin: string;
  dir: string;
  depth: number;
  extensions: string[];
  format: NonNullable<PluginManifest["format"]>;
  map: NonNullable<PluginManifest["map"]>;
}

const DEFAULT_EXTENSIONS = [".md", ".markdown"];

/**
 * Claude Code keeps subagents flat, one markdown file per agent, with a
 * frontmatter `name` and `description`. This is the compatibility `roles.ts`
 * has claimed in a comment since v0.1.0; the manifest is what makes it true.
 */
const CLAUDE: PluginManifest = {
  id: "claude",
  project: [join(".claude", "agents")],
  personal: [join(".claude", "agents")],
  map: { name: "name", description: "description" },
};

/**
 * Codex keeps agents as flat TOML rather than markdown, which is the whole
 * reason `format` exists: the seam between "where morse looks" and "how a file
 * is read" has to be real, or a plugin system is a `.claude` importer with
 * ceremony.
 *
 * `developer_instructions` is the prompt body, so it maps onto `brief`. Nothing
 * maps onto `skills` — `model`, `sandbox_mode` and the rest describe what the
 * agent is allowed to do, not what it is good at.
 */
const CODEX: PluginManifest = {
  id: "codex",
  project: [join(".codex", "agents")],
  personal: [join(".codex", "agents")],
  extensions: [".toml"],
  format: "toml",
  map: { name: "name", description: "description", brief: "developer_instructions" },
};

/**
 * pi namespaces agents by pack — `agents/<pack>/<name>.md` — so it needs one
 * level of nesting. Two packs may both define `architect`; that collision is
 * resolved the same way every other one is, first match wins, and `morse roles`
 * prints the source path so the shadowed copy is diagnosable.
 *
 * The personal root is `~/.pi/agent/agents`: `~/.pi/agent` is the config root,
 * the directory holding `settings.json`. pi's *project-local* convention is
 * unconfirmed, so both plausible roots are searched there and that is a hedge
 * rather than a finding — a missing directory is the normal case, so searching
 * one that turns out not to exist costs nothing, and guessing wrong would cost
 * a silently undiscovered agent.
 */
const PI: PluginManifest = {
  id: "pi",
  project: [join(".pi", "agent", "agents"), join(".pi", "agents")],
  personal: [join(".pi", "agent", "agents")],
  depth: 1,
  map: { name: "name", description: "description" },
};

/** Ordered, so precedence between plugins is documented rather than emergent. */
export const BUILTIN_PLUGINS: PluginManifest[] = [CLAUDE, CODEX, PI];

/**
 * Discovery is opt-out because it changes where an agent's instructions can
 * come from. Off must mean off: no plugin directory is read, and behaviour is
 * exactly what it was before plugins existed.
 */
export function pluginsEnabled(env = process.env): boolean {
  const setting = env.MORSE_PLUGINS?.trim().toLowerCase();
  return !(setting === "0" || setting === "off" || setting === "false" || setting === "no");
}

/**
 * A fourth ecosystem must not require patching morse, so manifests are also
 * read from disk: `.morse/plugins/*.json` in a project, and `plugins/*.json`
 * under `$MORSE_HOME`. They are data files, loaded with `JSON.parse` — there is
 * no path here that executes anything.
 */
/** A built-in that a manifest inside a project redefined, and the file that did it. */
export interface PluginOverride {
  id: string;
  path: string;
}

export function loadPlugins(roots: { project: string[]; morseHome: string }): {
  plugins: PluginManifest[];
  overrides: PluginOverride[];
} {
  const dirs = [
    ...roots.project.map((root) => ({ dir: join(root, ".morse", "plugins"), project: true })),
    { dir: join(roots.morseHome, "plugins"), project: false },
  ];

  const builtin = new Set(BUILTIN_PLUGINS.map((plugin) => plugin.id));
  const found = new Map<string, PluginManifest>();
  for (const plugin of BUILTIN_PLUGINS) found.set(plugin.id, plugin);
  const overrides: PluginOverride[] = [];
  const seen = new Set<string>();

  for (const { dir, project } of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // No user manifests is the overwhelmingly common case.
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const path = join(dir, entry);
      const manifest = readManifest(path);
      if (!manifest) continue;
      // A manifest may replace a built-in — that is how someone corrects
      // morse's idea of an ecosystem without waiting for a release. In your
      // home directory that is simply your configuration. In a project it
      // arrived with the repository, and quietly changing what `claude` means
      // is the same surprise provenance exists to prevent — so it is disclosed,
      // not refused.
      if (project && builtin.has(manifest.id)) overrides.push({ id: manifest.id, path });
      found.set(manifest.id, manifest);
    }
  }

  return { plugins: [...found.values()], overrides };
}

/** A manifest that does not parse is skipped: one bad file is not fatal. */
function readManifest(path: string): PluginManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
    if (!parsed || typeof parsed.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(parsed.id)) return undefined;
    if (parsed.format && parsed.format !== "frontmatter" && parsed.format !== "toml") return undefined;
    const dirs = [...(parsed.project ?? []), ...(parsed.personal ?? [])];
    // A manifest directory is joined onto a search root, so it must not be able
    // to climb out of one. Same rule a role name obeys, applied a level up.
    if (dirs.some((dir) => typeof dir !== "string" || dir.includes("..") || dir.startsWith("/"))) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * The directories one plugin contributes at one rung of the search ladder.
 * `root` is a project directory for `project` entries and the home directory
 * for `personal` ones; a rung that is neither contributes nothing.
 */
export function pluginDirs(
  plugins: PluginManifest[],
  root: string,
  scope: "project" | "personal",
): PluginDir[] {
  const dirs: PluginDir[] = [];
  for (const plugin of plugins) {
    for (const relative of plugin[scope] ?? []) {
      dirs.push({
        plugin: plugin.id,
        dir: join(root, relative),
        depth: plugin.depth ?? 0,
        extensions: plugin.extensions ?? DEFAULT_EXTENSIONS,
        format: plugin.format ?? "frontmatter",
        map: plugin.map ?? {},
      });
    }
  }
  return dirs;
}

/**
 * Every directory a plugin search covers, nearest first: the directory itself,
 * then one level per `depth`. Returned rather than walked lazily so `morse
 * roles` can report exactly what was looked at, including what was not there.
 */
export function expandDepth(dir: string, depth: number): string[] {
  if (depth <= 0) return [dir];
  const found = [dir];
  let frontier = [dir];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const current of frontier) {
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (entry.startsWith(".")) continue;
        const child = join(current, entry);
        try {
          if (statSync(child).isDirectory()) next.push(child);
        } catch {
          continue; // A dangling symlink is a file to skip, not a crash.
        }
      }
    }
    found.push(...next);
    frontier = next;
  }
  return found;
}

/** True when the path exists, for reporting search coverage honestly. */
export function dirExists(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
