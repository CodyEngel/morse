/**
 * A vendored, encode-only TOON writer — the format morse's model-facing
 * surfaces default to in 0.4.0 (docs/plans/0.4.0/efficiency.md, Decision 5).
 *
 * Written against TOON spec v4.1, verified against the reference
 * implementation `@toon-format/toon` 4.1.1: goldens in test/toon.test.js pin
 * this module's output, and every output is round-tripped through the
 * reference *decoder* — a dev-only dependency at the workspace root — so
 * "follows the spec" stays a tested property rather than a claim. Encode-only
 * because agents only ever *read* morse output: tool arguments arrive as JSON
 * over MCP and CLI verbs take flags, so morse never parses TOON. Vendored
 * because the published packages promise zero runtime dependencies.
 *
 * The subset is the shapes morse emits, each on the cheapest form it
 * qualifies for, everything else on a form that still decodes:
 *
 *   - scalars, flat `key: value` objects, nested objects by indentation;
 *   - arrays of scalars inline (`key[N]: a,b,c`);
 *   - arrays of uniform flat all-scalar objects as tables
 *     (`key[N]{f1,f2}:` plus one row per element) — rosters, inboxes,
 *     threads, exactly the payloads whose envelope keys repeat today;
 *   - anything ragged — mixed arrays, rows carrying arrays or objects — in
 *     list form (`key[N]:` plus `- ` items).
 *
 * Two reference-encoder forms are deliberately never emitted: nested field
 * groups in table headers (`o{x}`) and keyed tables (`key[N:]{...}`). They
 * compress shapes morse does not produce, and the nested and list forms this
 * writer falls back to decode to identical values.
 *
 * One deliberate divergence from the reference *encoder*: an object value of
 * `undefined` (or a function, or a symbol) drops its key, where the reference
 * writes `key: null`. Morse uses key absence and null to mean different
 * things — Decision 4's trimmed renderers delete keys like a null `subject`
 * outright — and JSON.stringify, the format this replaces, makes the same
 * call. Inside arrays both agree: the slot becomes null, as does a non-finite
 * number anywhere. Strings with lone surrogates are refused loudly, as the
 * reference refuses them: a document that cannot be valid UTF-8 has no
 * correct encoding, and following the registry's TOML reader, refusing beats
 * emitting something plausible and wrong.
 */

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json;
}

export function encodeToon(value: unknown): string {
  const root = normalize(value);
  if (root === undefined) return "null"; // As the reference: an unencodable root still yields a document.
  if (isScalar(root)) return scalarToken(root);
  const out: string[] = [];
  if (Array.isArray(root)) arrayLines(undefined, root, 0, out);
  else objectLines(root, 0, out);
  return out.join("\n"); // `{}` encodes to "" — the reference decodes an empty document back to {}.
}

// ---------------------------------------------------------------- normalize
// One pass down to plain JSON before any layout decision, because layout
// *depends* on it: a row whose `undefined` value drops its key changes the
// key set the table-uniformity check compares. `undefined` here means "this
// value has no representation" — object entries skip it, array slots turn it
// into null — which is precisely JSON.stringify's treatment of undefined,
// functions, and symbols.

function normalize(value: unknown): Json | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      refuseLoneSurrogates(value, "string value");
      return value;
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      // The reference's rule: exact as a number when safe, decimal text when
      // not — the text gets quoted below for looking like a number.
      return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString();
    case "object":
      break;
    default:
      return undefined; // undefined, function, symbol.
  }

  // Honour toJSON as JSON.stringify would, so a stray Date renders as its
  // ISO string instead of an empty object. The identity guard is the
  // reference's, against a toJSON that returns its own receiver.
  const raw = value as { toJSON?: unknown };
  if (typeof raw.toJSON === "function") {
    const replaced = (raw as { toJSON: () => unknown }).toJSON();
    if (replaced !== value) return normalize(replaced);
  }

  if (Array.isArray(value)) return value.map((item) => normalize(item) ?? null);

  const object: JsonObject = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalize(entry);
    if (normalized === undefined) continue;
    refuseLoneSurrogates(key, "object key");
    object[key] = normalized;
  }
  return object;
}

function refuseLoneSurrogates(text: string, what: string): void {
  if (!/[\uD800-\uDFFF]/.test(text)) return;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    const next = text.charCodeAt(index + 1);
    if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      index++; // A well-formed pair; skip its low half.
      continue;
    }
    throw new TypeError(`Cannot encode ${what} with an unpaired surrogate at index ${index}.`);
  }
}

// ------------------------------------------------------------------ scalars
// A string goes bare only when no reader could take it for anything else.
// The conditions are the reference's, verbatim, because every one guards a
// real misreading: literals and number-lookalikes (the spec's pattern — "05"
// and "1e5" quote, ".5" and "Infinity" need not, since no decoder reads them
// as numbers), structural characters (colon, comma, brackets, braces — an
// ISO timestamp quotes for its colons), escapes and control characters, the
// spec's space-only edge trimming, and the two line-start markers, `-` and
// `#`, that would turn a value into a list item or a comment.

const NUMBER_LIKE = /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const NEEDS_QUOTES = /[:,"\\[\]{}\u0000-\u001F]/;

function scalarToken(value: null | boolean | number | string): string {
  if (typeof value !== "string") return String(value);
  return bareSafe(value) ? value : `"${escapeText(value)}"`;
}

function bareSafe(value: string): boolean {
  if (value === "" || /^[ \t]|[ \t]$/.test(value)) return false;
  if (value === "true" || value === "false" || value === "null") return false;
  if (NUMBER_LIKE.test(value) || NEEDS_QUOTES.test(value)) return false;
  return !value.startsWith("-") && !value.startsWith("#");
}

function escapeText(value: string): string {
  return value.replace(/[\\"\u0000-\u001F]/g, (char) => {
    if (char === "\\") return "\\\\";
    if (char === '"') return '\\"';
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/** Keys quote by a stricter rule than values: bare means identifier-shaped. */
function keyToken(key: string): string {
  return /^[A-Za-z_][\w.]*$/.test(key) ? key : `"${escapeText(key)}"`;
}

// ------------------------------------------------------------------- layout

function isScalar(value: Json): value is null | boolean | number | string {
  return value === null || typeof value !== "object";
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function objectLines(object: JsonObject, depth: number, out: string[]): void {
  for (const [key, value] of Object.entries(object)) {
    if (isScalar(value)) out.push(`${indent(depth)}${keyToken(key)}: ${scalarToken(value)}`);
    else if (Array.isArray(value)) arrayLines(key, value, depth, out);
    else {
      out.push(`${indent(depth)}${keyToken(key)}:`); // An empty object is just its key — nothing follows.
      objectLines(value, depth + 1, out);
    }
  }
}

/** `key === undefined` is the document root, whose headers carry no name. */
function arrayLines(key: string | undefined, array: Json[], depth: number, out: string[]): void {
  const prefix = key === undefined ? "" : keyToken(key);
  if (array.length === 0) {
    // The reference spells emptiness differently by position: `[]` against a
    // key or alone at root, but `[0]:` as a list item (below).
    out.push(indent(depth) + (key === undefined ? "[]" : `${prefix}: []`));
    return;
  }
  if (array.every(isScalar)) {
    out.push(indent(depth) + inlineArray(prefix, array));
    return;
  }
  const fields = tabularFields(array);
  if (fields) {
    out.push(`${indent(depth)}${prefix}[${array.length}]{${fields.map(keyToken).join(",")}}:`);
    for (const row of array) {
      // tabularFields proved each row a flat record holding every field.
      const record = row as JsonObject;
      out.push(indent(depth + 1) + fields.map((field) => scalarToken(record[field] as Exclude<Json, Json[] | JsonObject>)).join(","));
    }
    return;
  }
  out.push(`${indent(depth)}${prefix}[${array.length}]:`);
  for (const item of array) listItemLines(item, depth + 1, out);
}

/** Callers guarantee all-scalar values; only the list-item path passes empty. */
function inlineArray(prefix: string, values: Json[]): string {
  const header = `${prefix}[${values.length}]:`;
  return values.length === 0 ? header : `${header} ${values.map((value) => scalarToken(value as Exclude<Json, Json[] | JsonObject>)).join(",")}`;
}

/**
 * The table test: every element a flat object with the *same key set* — the
 * first row's order names the columns, so insertion order is preserved and a
 * reordered row still lands its values under the right headers — and every
 * value a scalar. A single array or nested object anywhere sends the whole
 * array to list form: the reference declines rows it cannot lay flat (an
 * inbox whose `to` is an array, a roster whose `skills` is), and morse
 * declines the same rows for the same reason.
 */
function tabularFields(array: Json[]): string[] | undefined {
  const first = array[0];
  if (first === undefined || isScalar(first) || Array.isArray(first)) return undefined;
  const fields = Object.keys(first);
  if (fields.length === 0) return undefined;
  for (const row of array) {
    if (isScalar(row) || Array.isArray(row)) return undefined;
    if (Object.keys(row).length !== fields.length) return undefined;
    for (const field of fields) {
      if (!Object.hasOwn(row, field) || !isScalar(row[field] as Json)) return undefined;
    }
  }
  return fields;
}

function listItemLines(value: Json, depth: number, out: string[]): void {
  if (isScalar(value)) {
    out.push(`${indent(depth)}- ${scalarToken(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    // An array directly in list position never goes tabular — the reference
    // reserves tables for keyed arrays and the document root — so an
    // all-scalar one inlines and anything else recurses as deeper items.
    if (value.every(isScalar)) out.push(`${indent(depth)}- ${inlineArray("", value)}`);
    else {
      out.push(`${indent(depth)}- [${value.length}]:`);
      for (const item of value) listItemLines(item, depth + 1, out);
    }
    return;
  }
  if (Object.keys(value).length === 0) {
    out.push(`${indent(depth)}-`); // A bare dash, no trailing space.
    return;
  }
  // An object item rides the dash: render it one level deeper, then splice
  // its first line onto the `- `. The marker is exactly one indent unit
  // wide, so the first key lands where it would have anyway and everything
  // under it — including a table's rows — is already at the right depth.
  const block: string[] = [];
  objectLines(value, depth + 1, block);
  out.push(`${indent(depth)}- ${(block[0] as string).slice(indent(depth + 1).length)}`);
  for (let index = 1; index < block.length; index++) out.push(block[index] as string);
}
