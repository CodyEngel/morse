import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/**
 * A room is just a name. The store is machine-wide, so the room is what keeps
 * one project's agents from hearing another's.
 *
 * Precedence: $MORSE_ROOM -> git repository root's basename -> cwd's basename.
 */
export function resolveRoom(cwd = process.cwd()): string {
  const explicit = process.env.MORSE_ROOM?.trim();
  if (explicit) return sanitizeRoom(explicit);

  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return sanitizeRoom(basename(root));
  } catch {
    // Not a git repo, or git is unavailable. Fall through to the cwd name.
  }

  return sanitizeRoom(basename(cwd));
}

/**
 * A room name is now a path component — `~/.morse/rooms/<room>/agents` — and
 * not merely a SQL value, so it must not be able to climb out of the directory
 * it names. Slashes were already stripped, which stopped `../../etc`, but a
 * bare `..` survived: dots are legal in a room name and `-` trimming turned
 * `-..-` back into `..` on the way out.
 *
 * Anything that is only dots is refused rather than mangled. Mangling would
 * silently put an agent in a room it did not ask for, which is worse than
 * landing in `default` and being able to see that you did.
 */
export function sanitizeRoom(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned || /^\.+$/.test(cleaned)) return "default";
  return cleaned;
}
