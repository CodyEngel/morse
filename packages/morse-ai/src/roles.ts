import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  type PluginManifest,
  type PluginOverride,
  dirExists,
  expandDepth,
  loadPlugins,
  pluginDirs,
  pluginsEnabled,
} from "./plugins.js";
import { parseToml, tomlString } from "./toml.js";

/**
 * Morse ships no roles. It defines the shape of one and where to find them.
 *
 * A role is a markdown file whose frontmatter is what the room sees and whose
 * body is private guidance for that agent — the same split the bus already
 * makes between a published capability blurb and an agent's own instructions.
 * Deliberately the same shape as a Claude Code subagent file, so role packs are
 * just a directory of markdown someone can read, diff, and edit by hand.
 *
 *   ---
 *   role: Backend Engineer
 *   description: Owns APIs, data modelling, SQL, and query performance.
 *   skills: [sql, api-design, performance]
 *   ---
 *
 *   You own the API and data layer. Route UI questions to the frontend engineer.
 */
export interface RoleDefinition {
  /** Agent name. Defaults to the filename. */
  name: string;
  /** Human-readable title, e.g. "Backend Engineer". */
  role?: string;
  /** Published to the roster. What peers read when deciding who to ask. */
  description?: string;
  skills: string[];
  /** Private guidance appended to this agent's system prompt. */
  brief?: string;
  /** Where it was loaded from, so `morse roles` can show precedence. */
  source: string;
  /**
   * Which plugin supplied it, absent when it came from `.morse/roles`. A file
   * written for another tool can end up as an agent's system prompt, so where
   * it came from is never implicit.
   */
  plugin?: string;
}

/**
 * Where roles are looked up, nearest first. A project can override a shared
 * pack, and a pack is just a directory — which is all an "official roles"
 * package on npm needs to be.
 */
export function roleSearchPaths(cwd = process.cwd()): string[] {
  const paths: string[] = [join(cwd, ".morse", "roles")];

  const root = gitRoot(cwd);
  if (root && root !== cwd) paths.push(join(root, ".morse", "roles"));

  // $MORSE_ROLES points at shared packs, so it sits below the project but above
  // the personal default: a repo can override one role from a pack without
  // forking the pack, and the pack still beats whatever is in your home dir.
  const packs = process.env.MORSE_ROLES?.split(":").map((p) => p.trim()).filter(Boolean) ?? [];
  paths.push(...packs.map((p) => resolve(p)));

  paths.push(morseHomeRoles());

  return [...new Set(paths)];
}

function morseHomeRoles(): string {
  return join(process.env.MORSE_HOME ?? join(homedir(), ".morse"), "roles");
}

/** One directory to search, and how to read what is in it. */
export interface SearchDir {
  dir: string;
  /** Absent for `.morse/roles`; the plugin id for a borrowed directory. */
  plugin?: string;
  /** Nested levels below `dir` to descend. */
  depth: number;
  extensions: string[];
  format: "frontmatter" | "toml";
  /** Which frontmatter keys supply which fields; morse's own when absent. */
  map?: FieldMap;
}

const MORSE_EXTENSIONS = [".md", ".markdown"];

/**
 * The search ladder, widened by plugins.
 *
 * Plugins widen each rung rather than adding a rung of their own: a borrowed
 * definition found next to your project still loses to one found further away
 * only if that further one is nearer on the ladder. Within a rung, `.morse/roles`
 * is always first, so an explicit morse role shadows a borrowed one at the same
 * distance — writing the file is the way to say "I mean this one".
 *
 * `$MORSE_ROLES` is deliberately not widened. It points at morse-shaped packs,
 * and a pack that quietly started reading `.claude/agents` relative to itself
 * would be surprising in a way the project and home rungs are not.
 */
export function roleSearchDirs(cwd = process.cwd()): SearchDir[] {
  const morse = (dir: string): SearchDir => ({
    dir,
    depth: 0,
    extensions: MORSE_EXTENSIONS,
    format: "frontmatter",
  });
  const root = gitRoot(cwd);
  const projectRoots = root && root !== cwd ? [cwd, root] : [cwd];

  if (!pluginsEnabled()) return roleSearchPaths(cwd).map(morse);

  const { plugins } = loadPlugins({
    project: projectRoots,
    morseHome: process.env.MORSE_HOME ?? join(homedir(), ".morse"),
  });

  const dirs: SearchDir[] = [];
  for (const projectRoot of projectRoots) {
    dirs.push(morse(join(projectRoot, ".morse", "roles")));
    dirs.push(...borrowed(plugins, projectRoot, "project"));
  }

  const packs = process.env.MORSE_ROLES?.split(":").map((p) => p.trim()).filter(Boolean) ?? [];
  dirs.push(...packs.map((p) => morse(resolve(p))));

  dirs.push(morse(morseHomeRoles()));
  dirs.push(...borrowed(plugins, homedir(), "personal"));

  const seen = new Set<string>();
  return dirs.filter((entry) => {
    const key = `${entry.plugin ?? ""}\0${entry.dir}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function borrowed(plugins: PluginManifest[], root: string, scope: "project" | "personal"): SearchDir[] {
  return pluginDirs(plugins, root, scope).map((entry) => ({
    dir: entry.dir,
    plugin: entry.plugin,
    depth: entry.depth,
    extensions: entry.extensions,
    format: entry.format,
    map: entry.map,
  }));
}

/** Built-ins this project's own manifests redefined. Empty when plugins are off. */
export function roleSearchOverrides(cwd = process.cwd()): PluginOverride[] {
  if (!pluginsEnabled()) return [];
  const root = gitRoot(cwd);
  return loadPlugins({
    project: root && root !== cwd ? [cwd, root] : [cwd],
    morseHome: process.env.MORSE_HOME ?? join(homedir(), ".morse"),
  }).overrides;
}

/**
 * Every directory discovery actually looks at, in order, with whether it is
 * there. `morse roles` prints this: a role that did not turn up is almost
 * always a directory morse never looked in, and guessing at that is miserable.
 */
export function roleSearchReport(cwd = process.cwd()): { dir: string; plugin?: string; exists: boolean }[] {
  const report: { dir: string; plugin?: string; exists: boolean }[] = [];
  for (const entry of roleSearchDirs(cwd)) {
    for (const dir of expandDepth(entry.dir, entry.depth)) {
      report.push({ dir, plugin: entry.plugin, exists: dirExists(dir) });
    }
  }
  return report;
}

/**
 * A role name becomes a filename, so it must not be able to become a path.
 * `../../notes` would otherwise read any markdown file on the machine and feed
 * its body straight into an agent's system prompt.
 */
export function isValidRoleName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name.trim().toLowerCase()) && !name.includes("..");
}

/**
 * Why a file that was found did not become a role. "Morse didn't find my
 * agents" is unfalsifiable from outside — a typo, a symlinked home directory
 * and a TOML construct outside the subset all look identical — so a candidate
 * that is found and dropped has to be able to say which it was.
 */
export interface RoleRejection {
  path: string;
  plugin?: string;
  reason: "outside the searched directory" | "unreadable" | "unparseable";
}

export interface RoleSearch {
  role?: RoleDefinition;
  /** Candidates matching the requested name that were found and refused. */
  rejected: RoleRejection[];
}

/** First match wins, so a nearer definition shadows a shared one. */
export function loadRole(name: string, cwd = process.cwd()): RoleDefinition | undefined {
  return findRole(name, cwd).role;
}

/** `loadRole` plus the candidates it refused, for callers that report them. */
export function findRole(name: string, cwd = process.cwd()): RoleSearch {
  const wanted = name.trim().toLowerCase();
  const rejected: RoleRejection[] = [];
  if (!isValidRoleName(wanted)) return { rejected };

  for (const entry of roleSearchDirs(cwd)) {
    for (const dir of expandDepth(entry.dir, entry.depth)) {
      for (const extension of entry.extensions) {
        const path = join(dir, `${wanted}${extension}`);
        // Belt and braces: even with a validated name, never read outside the
        // directory we meant to search.
        if (!isInside(dir, path)) continue;
        const candidate = inspect(dir, path);
        if (!candidate) continue;
        if ("reason" in candidate) {
          rejected.push({ path, plugin: entry.plugin, reason: candidate.reason });
          continue;
        }
        const role = parseDefinition(candidate.text, path, entry);
        if (!role) {
          rejected.push({ path, plugin: entry.plugin, reason: "unparseable" });
          continue;
        }
        return { role, rejected };
      }
    }
  }
  return { rejected };
}

export function isInside(dir: string, path: string): boolean {
  const base = resolve(dir);
  const target = resolve(path);
  return target === base || target.startsWith(base + sep);
}

/**
 * `isInside` resolves lexically, which catches `..` and catches nothing else. A
 * role file is not just read, its body becomes an agent's system prompt — so a
 * symlink committed to a repository (git stores and restores mode 120000) would
 * turn `git clone && morse join backend` into reading whatever it points at,
 * private keys included. Resolve both ends before deciding.
 *
 * The check is containment, not a ban on symlinks: a roles directory that is
 * itself a link, or one alias pointing at a sibling definition, is ordinary and
 * keeps working. Only leaving the directory is refused. A link that resolves
 * nowhere is simply absent — the same as any other missing file.
 */
/**
 * Look at one candidate: its text, the reason it was refused, or nothing at all
 * if there is no such directory entry.
 *
 * Existence and containment are the same operation on purpose. `realpathSync`
 * throws for a missing file and for a dangling symlink alike, so one `try`
 * covers both and there is no window between an `existsSync` and a read. Both
 * ends are resolved or neither: on macOS `/var` is a symlink to `/private/var`,
 * so resolving only the candidate rejects files that are genuinely inside the
 * directory searched — and that failure is silent under-discovery, on one
 * platform, which is the worst shape a bug here can take.
 */
function inspect(dir: string, path: string): { text: string } | { reason: RoleRejection["reason"] } | undefined {
  try {
    lstatSync(path);
  } catch {
    return undefined; // Nothing of that name; not a rejection, just absence.
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    // The entry is there but resolves nowhere: a dangling symlink. Missing as
    // far as loading goes, but the user asked for it, so say so.
    return { reason: "unreadable" };
  }
  try {
    if (!isInside(realpathSync(dir), real)) return { reason: "outside the searched directory" };
    // A directory named `backend.md` is offered by readdir and fails on read.
    // It occupies the name the user asked for, so it is a refusal to report,
    // not an absence to stay quiet about.
    if (!statSync(real).isFile()) return { reason: "unreadable" };
    return { text: readFileSync(real, "utf8") };
  } catch {
    return { reason: "unreadable" };
  }
}

export function listRoles(cwd = process.cwd()): RoleDefinition[] {
  return collectRoles(cwd).roles;
}

/** `listRoles` plus everything found and refused, so `morse roles` can say so. */
export function collectRoles(cwd = process.cwd()): { roles: RoleDefinition[]; rejected: RoleRejection[] } {
  const seen = new Map<string, RoleDefinition>();
  const rejected: RoleRejection[] = [];

  for (const entry of roleSearchDirs(cwd)) {
    const pattern = new RegExp(`(${entry.extensions.map(escapeExtension).join("|")})$`, "i");
    for (const dir of expandDepth(entry.dir, entry.depth)) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue; // Missing search directories are normal, not an error.
      }
      for (const file of entries.sort()) {
        if (!pattern.test(file)) continue;
        const path = join(dir, file);
        // A plugin points morse at directories it does not control, so a single
        // odd entry in someone's `.claude/agents` must not break `morse roles`
        // — but it must not vanish without explanation either.
        const candidate = inspect(dir, path);
        if (!candidate) continue;
        if ("reason" in candidate) {
          rejected.push({ path, plugin: entry.plugin, reason: candidate.reason });
          continue;
        }
        const definition = parseDefinition(candidate.text, path, entry);
        if (!definition) {
          rejected.push({ path, plugin: entry.plugin, reason: "unparseable" });
          continue;
        }
        if (!seen.has(definition.name)) seen.set(definition.name, definition);
      }
    }
  }
  return { roles: [...seen.values()], rejected };
}

/**
 * Read one file according to its plugin's format. `undefined` means the file
 * was refused — never a partial result, because a role with a quietly truncated
 * brief is worse than no role at all: the user cannot see that anything is
 * wrong, and the truncation is in a system prompt.
 */
function parseDefinition(text: string, source: string, entry: SearchDir): RoleDefinition | undefined {
  if (entry.format === "toml") {
    return parseTomlRole(text, source, { map: entry.map ?? {}, plugin: entry.plugin });
  }
  return parseRole(text, source, { map: entry.map, plugin: entry.plugin });
}

/** Codex-shaped: no document body, so the brief is a mapped field. */
export function parseTomlRole(text: string, source: string, options: ParseOptions = {}): RoleDefinition | undefined {
  const fields = parseToml(text);
  if (!fields) return undefined;
  const map = options.map ?? {};
  const brief = tomlString(fields, map.brief)?.trim();
  return {
    name: (tomlString(fields, map.name) ?? basename(source).replace(/\.[^.]+$/, "")).toLowerCase(),
    role: asString(tomlString(fields, map.role)),
    description: asString(tomlString(fields, map.description)),
    skills: asList(tomlString(fields, map.skills)),
    brief: brief || undefined,
    source,
    ...(options.plugin ? { plugin: options.plugin } : {}),
  };
}

function escapeExtension(extension: string): string {
  return extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which key in the source format supplies each field. Absent keys stay absent. */
export type FieldMap = Partial<Record<"name" | "role" | "description" | "skills" | "brief", string>>;

const MORSE_FIELDS: FieldMap = { name: "name", role: "role", description: "description", skills: "skills" };

export interface ParseOptions {
  /**
   * Another ecosystem's key names. Passed whole rather than merged over morse's
   * own, so a plugin that says nothing about `skills` gets none — see the note
   * on `PluginManifest.map` for why inventing them is worse than leaving them
   * empty.
   */
  map?: FieldMap;
  plugin?: string;
}

export function parseRole(text: string, source: string, options: ParseOptions = {}): RoleDefinition {
  const map = options.map ?? MORSE_FIELDS;
  const { fields, body } = splitFrontmatter(text);
  const fallbackName = basename(source).replace(/\.[^.]+$/, "");
  const brief = body.trim();
  const field = (key: keyof FieldMap) => (map[key] === undefined ? undefined : fields[map[key]]);
  const name = field("name") ?? fallbackName;
  return {
    name: name.toString().toLowerCase(),
    role: asString(field("role")),
    description: asString(field("description")),
    skills: asList(field("skills")),
    brief: brief || undefined,
    source,
    ...(options.plugin ? { plugin: options.plugin } : {}),
  };
}

type Fields = Record<string, string | string[]>;

/**
 * A deliberately small frontmatter reader: `key: value`, inline `[a, b]` lists,
 * and `- item` block lists. That covers the role contract without taking on a
 * YAML dependency, and anything it cannot parse is a sign the file is doing
 * more than a role definition should.
 */
function splitFrontmatter(text: string): { fields: Fields; body: string } {
  const normalized = text.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized);
  if (!match) return { fields: {}, body: normalized };

  const fields: Fields = {};
  const lines = match[1]!.split(/\r?\n/);
  let currentKey: string | undefined;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      const existing = fields[currentKey];
      const list = Array.isArray(existing) ? existing : [];
      list.push(unquote(listItem[1]!));
      fields[currentKey] = list;
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    currentKey = key!;
    const value = rawValue!.trim();

    if (value === "") {
      fields[currentKey] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      fields[currentKey] = value
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
    } else {
      fields[currentKey] = unquote(value);
    }
  }

  return { fields, body: normalized.slice(match[0].length) };
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

function asString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value.join(", ") : value;
  return text.trim() || undefined;
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function gitRoot(cwd: string): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

/** Scaffold shown by `morse roles new`, and the contract's reference example. */
export function roleTemplate(name: string): string {
  return `---
role: ${title(name)}
description: Name what you own and, just as importantly, what you do not. This is what teammates read when deciding who to ask.
skills: [replace-me, with-short-tags]
---

Private guidance for this agent, appended to its system prompt. Say how it
should behave, what it should push back on, and who it should route work to
when a request lands outside its lane.
`;
}

function title(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}
