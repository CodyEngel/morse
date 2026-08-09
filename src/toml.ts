/**
 * A deliberately small TOML reader, for the one thing morse needs from TOML:
 * the root-level string fields of a Codex agent file.
 *
 * Node ships no TOML parser and morse has no runtime dependencies, so this is
 * hand-written — which makes what it *refuses* more important than what it
 * accepts. The field it exists to read is `developer_instructions`, a prompt
 * body, and the natural way to write one is a triple-quoted string:
 *
 *   developer_instructions = """
 *   You own the API layer.
 *   """
 *
 * A line-oriented `key = "value"` reader does not fail on that. It takes the
 * value as the literal `"""`, drops the prompt as unparseable lines, and hands
 * back a role that looks right in `morse roles` with a silently truncated
 * system prompt. So: no best-effort parsing. Anything outside the documented
 * subset refuses the whole file, and the caller reports the refusal rather than
 * quietly skipping it.
 *
 * Accepted: comments, blank lines, `key = "basic"`, `key = """multi-line"""`,
 * and one-line values of any other type — recorded as opaque, never read as
 * text, so a `temperature = 0.1` sitting next to the fields we want does not
 * disqualify a perfectly good file.
 *
 * Refused: tables, dotted keys, literal `'''` strings, multi-line arrays, and
 * any line that is not a comment or a key/value pair.
 *
 * Refusing tables is a choice worth naming, because stopping at the first table
 * header would also be correct TOML — root keys must precede tables, so nothing
 * after one can be a field we map. The subset is drawn tighter than correctness
 * requires: a file using constructs this reader does not model is a file it has
 * no business claiming to understand, and under P21 a refusal is reported to
 * the user rather than swallowed. An agent that does not load and says why
 * beats one that loads and might be wrong.
 */

/** An opaque value is present but not text; asking for it as a string fails. */
export type TomlValue = { kind: "string"; value: string } | { kind: "opaque" };

/** `undefined` means refused — the file is outside the subset, not empty. */
export function parseToml(text: string): Record<string, TomlValue> | undefined {
  const fields: Record<string, TomlValue> = {};
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) return undefined; // A table: outside the subset.

    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!pair) return undefined; // Dotted keys and anything else land here.
    const [, key, rest] = pair;
    const value = rest!.trim();

    if (value.startsWith('"""')) {
      const multiline = readMultiline(lines, index, value);
      if (!multiline) return undefined; // Unterminated: refuse, never truncate.
      fields[key!] = { kind: "string", value: multiline.value };
      index = multiline.endLine;
      continue;
    }

    if (value.startsWith('"')) {
      const basic = readBasic(value);
      if (basic === undefined) return undefined;
      fields[key!] = { kind: "string", value: basic };
      continue;
    }

    // Any other one-line value: recorded, never interpreted. A construct that
    // spans lines (a multi-line array, a `'''` literal) leaves its remaining
    // lines behind, and those fail the key/value match above — so the file is
    // refused rather than half-read.
    fields[key!] = { kind: "opaque" };
  }

  return fields;
}

/** Read a value as text, or fail if it is not a string. */
export function tomlString(fields: Record<string, TomlValue>, key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const field = fields[key];
  return field?.kind === "string" ? field.value : undefined;
}

interface Multiline {
  value: string;
  endLine: number;
}

function readMultiline(lines: string[], start: number, first: string): Multiline | undefined {
  const opened = first.slice(3);
  // TOML trims a newline immediately after the opening delimiter, so
  // `"""\ntext"""` and `"""text"""` mean the same thing.
  const closing = opened.indexOf('"""');
  if (closing !== -1) {
    return trailing(opened.slice(closing + 3)) ? { value: opened.slice(0, closing), endLine: start } : undefined;
  }

  const collected: string[] = opened ? [opened] : [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    const end = line.indexOf('"""');
    if (end === -1) {
      collected.push(line);
      continue;
    }
    if (!trailing(line.slice(end + 3))) return undefined;
    collected.push(line.slice(0, end));
    return { value: unescape(collected.join("\n").replace(/\n$/, "")), endLine: index };
  }
  return undefined; // Never closed.
}

/** Only a comment may follow a closing delimiter. */
function trailing(rest: string): boolean {
  const text = rest.trim();
  return text === "" || text.startsWith("#");
}

function readBasic(value: string): string | undefined {
  let out = "";
  for (let index = 1; index < value.length; index++) {
    const char = value[index]!;
    if (char === "\\") {
      const escaped = ESCAPES[value[index + 1] ?? ""];
      if (escaped === undefined) return undefined; // Unknown escape: refuse.
      out += escaped;
      index++;
      continue;
    }
    if (char === '"') return trailing(value.slice(index + 1)) ? out : undefined;
    out += char;
  }
  return undefined; // Unterminated.
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
};

function unescape(text: string): string {
  // Multi-line basic strings take the same escapes; an unknown one is left as
  // written rather than refusing, because by this point the string's extent is
  // already known and no field can be silently truncated.
  return text.replace(/\\(.)/g, (match, char: string) => ESCAPES[char] ?? match);
}
