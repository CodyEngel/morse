import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

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

  paths.push(join(process.env.MORSE_HOME ?? join(homedir(), ".morse"), "roles"));

  return [...new Set(paths)];
}

/**
 * A role name becomes a filename, so it must not be able to become a path.
 * `../../notes` would otherwise read any markdown file on the machine and feed
 * its body straight into an agent's system prompt.
 */
export function isValidRoleName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name.trim().toLowerCase()) && !name.includes("..");
}

/** First match wins, so a nearer definition shadows a shared one. */
export function loadRole(name: string, cwd = process.cwd()): RoleDefinition | undefined {
  const wanted = name.trim().toLowerCase();
  if (!isValidRoleName(wanted)) return undefined;

  for (const dir of roleSearchPaths(cwd)) {
    for (const extension of [".md", ".markdown"]) {
      const path = join(dir, `${wanted}${extension}`);
      // Belt and braces: even with a validated name, never read outside the
      // directory we meant to search.
      if (!isInside(dir, path)) continue;
      if (existsSync(path)) return parseRole(readFileSync(path, "utf8"), path);
    }
  }
  return undefined;
}

export function isInside(dir: string, path: string): boolean {
  const base = resolve(dir);
  const target = resolve(path);
  return target === base || target.startsWith(base + sep);
}

export function listRoles(cwd = process.cwd()): RoleDefinition[] {
  const seen = new Map<string, RoleDefinition>();
  for (const dir of roleSearchPaths(cwd)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // Missing search directories are normal, not an error.
    }
    for (const entry of entries.sort()) {
      if (!/\.(md|markdown)$/i.test(entry)) continue;
      const definition = parseRole(readFileSync(join(dir, entry), "utf8"), join(dir, entry));
      if (!seen.has(definition.name)) seen.set(definition.name, definition);
    }
  }
  return [...seen.values()];
}

export function parseRole(text: string, source: string): RoleDefinition {
  const { fields, body } = splitFrontmatter(text);
  const fallbackName = basename(source).replace(/\.(md|markdown)$/i, "");
  const brief = body.trim();
  return {
    name: (fields.name ?? fallbackName).toString().toLowerCase(),
    role: asString(fields.role),
    description: asString(fields.description),
    skills: asList(fields.skills),
    brief: brief || undefined,
    source,
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
