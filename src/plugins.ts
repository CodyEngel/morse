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
   * How the file is read. Only `frontmatter` is implemented — the field exists
   * so that an ecosystem storing agents in another format (Codex writes TOML)
   * is a new manifest and a new reader, not a change to discovery itself.
   */
  format?: "frontmatter";
  /**
   * Which key in that ecosystem's frontmatter supplies each morse field.
   * Anything left out is absent rather than guessed.
   *
   * Note what is deliberately missing: `skills`. Claude and pi both carry a
   * `tools:` list, but that is a tool allowlist, not a capability blurb — and
   * agents route work by reading skills off the roster. A borrowed role arrives
   * with no skills, which is honest; `role` and `description` carry the signal.
   */
  map?: Partial<Record<"name" | "role" | "description" | "skills", string>>;
}

/** A directory a plugin contributed, and the plugin that contributed it. */
export interface PluginDir {
  plugin: string;
  dir: string;
  depth: number;
  extensions: string[];
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
 * pi namespaces agents by pack — `agents/<pack>/<name>.md` — so it needs one
 * level of nesting. Two packs may both define `architect`; that collision is
 * resolved the same way every other one is, first match wins, and `morse roles`
 * prints the source path so the shadowed copy is diagnosable.
 *
 * Both roots are listed because pi's live layout is unconfirmed: a missing
 * directory is the normal case, so searching both costs nothing and guessing
 * wrong costs a silently undiscovered agent.
 */
const PI: PluginManifest = {
  id: "pi",
  project: [join(".pi", "agent", "agents"), join(".pi", "agents")],
  personal: [join(".pi", "agent", "agents"), join(".pi", "agents")],
  depth: 1,
  map: { name: "name", description: "description" },
};

/** Ordered, so precedence between plugins is documented rather than emergent. */
export const BUILTIN_PLUGINS: PluginManifest[] = [CLAUDE, PI];

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
export function loadPlugins(roots: { project: string[]; morseHome: string }): PluginManifest[] {
  const dirs = [
    ...roots.project.map((root) => join(root, ".morse", "plugins")),
    join(roots.morseHome, "plugins"),
  ];

  const found = new Map<string, PluginManifest>();
  for (const plugin of BUILTIN_PLUGINS) found.set(plugin.id, plugin);

  for (const dir of [...new Set(dirs)]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // No user manifests is the overwhelmingly common case.
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const manifest = readManifest(join(dir, entry));
      // A user manifest may replace a built-in — that is how someone corrects
      // morse's idea of an ecosystem without waiting for a release.
      if (manifest) found.set(manifest.id, manifest);
    }
  }

  return [...found.values()];
}

/** A manifest that does not parse is skipped: one bad file is not fatal. */
function readManifest(path: string): PluginManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
    if (!parsed || typeof parsed.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(parsed.id)) return undefined;
    if (parsed.format && parsed.format !== "frontmatter") return undefined;
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
