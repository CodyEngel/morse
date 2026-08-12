import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, encode as referenceEncode } from "@toon-format/toon";
import { encodeToon } from "../packages/morse-ai/dist/toon.js";

// Two gates, per docs/plans/0.4.0/efficiency.md Decision 5. Goldens pin the
// exact bytes morse emits, so a formatting drift is a deliberate diff here
// rather than a silent change on every tool result. And every encoding —
// golden or edge case — must satisfy the reference decoder in its default
// strict mode and come back as the JSON view of the source:
// JSON.parse(JSON.stringify(...)) normalizes undefined exactly the way the
// encoder promises to, so the comparison *is* the JSON-parity claim.
function verify(value) {
  const text = encodeToon(value);
  assert.deepEqual(decode(text), JSON.parse(JSON.stringify(value)));
  return text;
}

function golden(value, expected) {
  assert.equal(encodeToon(value), expected);
  verify(value);
}

// ---------------------------------------------------------------- payloads

// The wait result as the tools render it today: `to` is an array on every
// message, and a row carrying an array cannot lay flat — the reference
// declines it, so the whole array takes list form, one `- ` item per
// message. (The 0.4.0 plan sketched this payload as tabular; the reference
// says otherwise, and the reference wins. The dieted shape below is the one
// that tables.)
const WAIT_LIST = {
  messages: [
    {
      id: 41,
      thread_id: "t-7",
      from: "planner",
      to: ["backend"],
      kind: "task",
      body: "Add a `GET /health` route: return `{ok: true}`, status 200.",
      at: "2026-08-11T14:03:22.117Z",
    },
    {
      id: 42,
      thread_id: "t-7",
      from: "backend",
      to: ["planner", "reviewer"],
      kind: "reply",
      body: 'Done, deployed.\nSay "go" when you want the smoke test.',
      at: "2026-08-11T14:04:05.902Z",
    },
    {
      id: 43,
      thread_id: "t-9",
      from: "frontend",
      to: ["backend"],
      kind: "system",
      body: "デプロイ完了 🚀 お疲れさまでした",
      at: "2026-08-11T14:05:59.000Z",
    },
  ],
  hint: "Reply on the same thread_id.",
};

// The same inbox after Decision 4's diet drops `to` when it is only the
// reader: every value a scalar, every key set identical — the shape TOON
// exists for. Envelope keys are named once in the header and never again.
const WAIT_TABULAR = {
  messages: [
    {
      id: 41,
      thread_id: "t-7",
      from: "planner",
      kind: "task",
      body: "Add a `GET /health` route: return `{ok: true}`, status 200.",
      at: "2026-08-11T14:03:22.117Z",
    },
    {
      id: 42,
      thread_id: "t-7",
      from: "backend",
      kind: "reply",
      body: 'Done, deployed.\nSay "go" when you want the smoke test.',
      at: "2026-08-11T14:04:05.902Z",
    },
    { id: 43, thread_id: "t-9", from: "frontend", kind: "ask", body: "null", at: "2026-08-11T14:05:59.000Z" },
    { id: 44, thread_id: "t-9", from: "backend", kind: "reply", body: "42", at: "2026-08-11T14:06:10.450Z" },
  ],
  hint: "Reply on the same thread_id.",
};

const ROSTER = {
  room: "morse",
  you: "backend",
  agents: [
    {
      name: "backend",
      role: "Backend Engineer",
      description: "Owns APIs and data modelling.",
      skills: ["sql", "api-design"],
      status: "working",
      note: null,
      online: true,
    },
    {
      name: "frontend",
      role: "Frontend Engineer",
      description: "Owns the UI layer.",
      skills: ["react", "css"],
      status: "idle",
      note: null,
      online: true,
    },
    {
      name: "reviewer",
      role: "Code Reviewer",
      description: "Reads every diff.",
      skills: [],
      status: "done",
      note: "PR #12 approved",
      online: false,
    },
  ],
  online: 2,
};

const REGISTERED = {
  you: "backend",
  room: "morse",
  registered: {
    name: "backend",
    role: "Backend Engineer",
    description: "Owns APIs and data modelling.",
    skills: ["sql", "api-design"],
    status: "idle",
    note: null,
    online: true,
  },
  roster: [],
  notice:
    "You are the first one here. Teammates and instructions arrive over morse — park with `morse_wait` and stay parked.",
  hint: "Check the roster before asking questions, and call morse_wait when you have nothing to do.",
};

// ----------------------------------------------------------------- goldens

test("a wait result whose rows carry `to` arrays encodes in list form", () => {
  golden(
    WAIT_LIST,
    `messages[3]:
  - id: 41
    thread_id: t-7
    from: planner
    to[1]: backend
    kind: task
    body: "Add a \`GET /health\` route: return \`{ok: true}\`, status 200."
    at: "2026-08-11T14:03:22.117Z"
  - id: 42
    thread_id: t-7
    from: backend
    to[2]: planner,reviewer
    kind: reply
    body: "Done, deployed.\\nSay \\"go\\" when you want the smoke test."
    at: "2026-08-11T14:04:05.902Z"
  - id: 43
    thread_id: t-9
    from: frontend
    to[1]: backend
    kind: system
    body: デプロイ完了 🚀 お疲れさまでした
    at: "2026-08-11T14:05:59.000Z"
hint: Reply on the same thread_id.`,
  );
});

// The bodies here are the traps: backticks stay bare; colons, commas, braces
// and quotes force quoting; a newline survives as a \n escape inside one
// row; "null" and "42" quote so they come back as the strings they are; and
// every `at` quotes for its colons.
test("a wait result with all-scalar rows encodes tabular, keys named once", () => {
  golden(
    WAIT_TABULAR,
    `messages[4]{id,thread_id,from,kind,body,at}:
  41,t-7,planner,task,"Add a \`GET /health\` route: return \`{ok: true}\`, status 200.","2026-08-11T14:03:22.117Z"
  42,t-7,backend,reply,"Done, deployed.\\nSay \\"go\\" when you want the smoke test.","2026-08-11T14:04:05.902Z"
  43,t-9,frontend,ask,"null","2026-08-11T14:05:59.000Z"
  44,t-9,backend,reply,"42","2026-08-11T14:06:10.450Z"
hint: Reply on the same thread_id.`,
  );
});

// The whole point of the diet: the tabular inbox beats compact JSON (~29%
// here), while the list form above actually runs a few bytes over it. If
// this assertion ever fails, tabular detection regressed and the default
// format is quietly worse than the JSON it replaced.
test("the tabular wait result is smaller than its compact JSON", () => {
  const json = Buffer.byteLength(JSON.stringify(WAIT_TABULAR), "utf8");
  const toon = Buffer.byteLength(encodeToon(WAIT_TABULAR), "utf8");
  assert.ok(toon < json, `TOON ${toon} bytes should beat compact JSON ${json} bytes`);
});

// Verified against the reference: an array value inside a row (`skills`)
// disqualifies tabular form — there is no spec shape for a cell that is a
// list — so a roster stays in list form until its renderer flattens skills.
test("a roster keeps agents in list form because skills is an array per row", () => {
  golden(
    ROSTER,
    `room: morse
you: backend
agents[3]:
  - name: backend
    role: Backend Engineer
    description: Owns APIs and data modelling.
    skills[2]: sql,api-design
    status: working
    note: null
    online: true
  - name: frontend
    role: Frontend Engineer
    description: Owns the UI layer.
    skills[2]: react,css
    status: idle
    note: null
    online: true
  - name: reviewer
    role: Code Reviewer
    description: Reads every diff.
    skills: []
    status: done
    note: PR #12 approved
    online: false
online: 2`,
  );
});

test("a register response: nested object, notice, empty roster, null note", () => {
  golden(
    REGISTERED,
    `you: backend
room: morse
registered:
  name: backend
  role: Backend Engineer
  description: Owns APIs and data modelling.
  skills[2]: sql,api-design
  status: idle
  note: null
  online: true
roster: []
notice: You are the first one here. Teammates and instructions arrive over morse — park with \`morse_wait\` and stay parked.
hint: "Check the roster before asking questions, and call morse_wait when you have nothing to do."`,
  );
});

test("root values: scalars, empty object, empty array", () => {
  golden("hello", "hello");
  golden("null", '"null"');
  golden("", '""');
  golden(42, "42");
  golden(-2.5, "-2.5");
  golden(0, "0");
  golden(true, "true");
  golden(false, "false");
  golden(null, "null");
  golden({}, "");
  golden([], "[]");
  golden([1, 2, 3], "[3]: 1,2,3");
  golden([{ a: 1 }, { a: 2 }], "[2]{a}:\n  1\n  2");
});

// The exact conditions come from the reference implementation, not from
// Number(): "05", "+1" and "1e5" quote because the spec's number pattern
// matches them, while ".5", "5.", "Infinity" and "NaN" stay bare because it
// does not — and no decoder reads those as numbers, so they come back as
// the strings they are.
test("strings quote exactly when a reader could mistake them", () => {
  const lines = [
    ["plain text stays bare", "k: plain text stays bare"],
    ["with: colon", 'k: "with: colon"'],
    ["a,b", 'k: "a,b"'],
    ['say "hi"', 'k: "say \\"hi\\""'],
    ["back\\slash", 'k: "back\\\\slash"'],
    ["line\nbreak", 'k: "line\\nbreak"'],
    ["cr\rhere", 'k: "cr\\rhere"'],
    ["tab\there", 'k: "tab\\there"'],
    ["\u0007bell", 'k: "\\u0007bell"'],
    ["null", 'k: "null"'],
    ["true", 'k: "true"'],
    ["false", 'k: "false"'],
    ["42", 'k: "42"'],
    ["-42", 'k: "-42"'],
    ["05", 'k: "05"'],
    ["+1", 'k: "+1"'],
    ["1e5", 'k: "1e5"'],
    [".5", "k: .5"],
    ["5.", "k: 5."],
    ["Infinity", "k: Infinity"],
    ["NaN", "k: NaN"],
    ["- item", 'k: "- item"'],
    ["-item", 'k: "-item"'],
    ["#comment", 'k: "#comment"'],
    ["not#comment", "k: not#comment"],
    ["[x]", 'k: "[x]"'],
    ["{y}", 'k: "{y}"'],
    ["(z)", "k: (z)"],
    [" lead", 'k: " lead"'],
    ["trail ", 'k: "trail "'],
    ["", 'k: ""'],
    ['"quoted"', 'k: "\\"quoted\\""'],
    ["`tick`", "k: `tick`"],
    ["it's", "k: it's"],
    ["a|b", "k: a|b"],
    ["semi;colon", "k: semi;colon"],
    ["true2", "k: true2"],
  ];
  for (const [value, expected] of lines) golden({ k: value }, expected);
  // The same strings as inline-array entries and as tabular cells, where the
  // comma delimiter makes quoting load-bearing.
  verify({ list: lines.map(([value]) => value) });
  verify({ rows: lines.map(([value], id) => ({ id, body: value })) });
});

test("undefined object values drop their key; undefined array slots become null", () => {
  golden({ subject: undefined, body: "x" }, "body: x");
  golden({ a: [1, undefined, 2] }, "a[3]: 1,null,2");
  // Functions and symbols get JSON.stringify's treatment too.
  verify({ fn: () => 1, kept: true });
  verify({ list: [() => 1, "kept"] });
});

test("non-finite numbers become null, as in JSON", () => {
  golden({ a: NaN, b: Infinity, c: -Infinity }, "a: null\nb: null\nc: null");
  verify({ big: 1e21, tiny: 5e-7, max: Number.MAX_SAFE_INTEGER, neg: -3.75 });
});

test("arrays: inline scalars, tabular uniformity, and the list fallback", () => {
  golden({ k: [1, "two", true, null] }, "k[4]: 1,two,true,null");
  // Key order may differ per row; the key *set* decides, and the first
  // row's order names the columns, so the reordered row lands its values
  // under the right headers.
  golden({ k: [{ a: 1, b: 2 }, { b: 4, a: 3 }] }, "k[2]{a,b}:\n  1,2\n  3,4");
  // A column may mix scalar types — only structure disqualifies.
  golden({ k: [{ id: 1 }, { id: "x" }, { id: null }, { id: true }] }, "k[4]{id}:\n  1\n  x\n  null\n  true");
  // Ragged key sets fall back to list form, missing keys simply absent.
  golden({ k: [{ a: 1 }, { a: 2, b: 3 }] }, "k[2]:\n  - a: 1\n  - a: 2\n    b: 3");
  // Empty objects have no columns to name: list form, bare dashes.
  golden({ k: [{}, {}] }, "k[2]:\n  -\n  -");
  golden({ k: [[1, 2], [3, 4]] }, "k[2]:\n  - [2]: 1,2\n  - [2]: 3,4");
  golden({ k: [1, { a: 1 }] }, "k[2]:\n  - 1\n  - a: 1");
  // A list-item object rides the dash with its first key; an array or
  // object value there indents its contents one level past the dash line.
  golden({ k: [{ first: [1, 2], second: "s" }] }, "k[1]:\n  - first[2]: 1,2\n    second: s");
  golden(
    { k: [{ deep: { x: 1 }, after: [1, { z: 9 }] }, 7] },
    "k[2]:\n  - deep:\n      x: 1\n    after[2]:\n      - 1\n      - z: 9\n  - 7",
  );
});

test("empty containers in every position", () => {
  golden({ a: {} }, "a:");
  golden({ a: [] }, "a: []");
  golden({ a: { b: {} } }, "a:\n  b:");
  golden({ a: [[]] }, "a[1]:\n  - [0]:");
  golden({ a: [{}, []] }, "a[2]:\n  -\n  - [0]:");
});

// Shapes the reference encoder compresses further — uniform rows of nested
// objects become `o{x}` field groups, objects of uniform objects become
// keyed tables — are outside morse's deliberate subset. The fallback forms
// must still decode to identical values, which is what makes the subset a
// choice rather than a defect.
test("shapes the reference compresses further still decode identically", () => {
  verify({ k: [{ a: 1, o: { x: 1 } }, { a: 2, o: { x: 2 } }] });
  verify({ k: { alice: { age: 1 }, bob: { age: 2 } } });
});

test("unicode passes through bare; lone surrogates are refused", () => {
  golden({ k: "emoji 🚀🔥 and 日本語" }, "k: emoji 🚀🔥 and 日本語");
  golden({ k: "𝔘nicode astral café" }, "k: 𝔘nicode astral café");
  assert.throws(() => encodeToon({ k: "bad\ud800end" }), TypeError);
  assert.throws(() => encodeToon({ "k\udfff": 1 }), TypeError);
});

test("a long paragraph body rides a tabular row intact", () => {
  const paragraph =
    "The registry keeps one row per agent and the bus keeps one row per message, which means a wait " +
    "that returns three messages repeats the same seven envelope keys three times over; a tabular " +
    "encoding names those keys once in the header and then spends its remaining bytes purely on " +
    "identifiers, timestamps, and the bodies themselves.";
  const text = verify({
    messages: [
      { id: 50, thread_id: "t-11", from: "planner", kind: "task", body: paragraph, at: "2026-08-11T15:00:00.000Z" },
      { id: 51, thread_id: "t-11", from: "backend", kind: "reply", body: "On it.", at: "2026-08-11T15:00:41.128Z" },
      { id: 52, thread_id: "t-11", from: "planner", kind: "reply", body: "Thanks!", at: "2026-08-11T15:01:02.552Z" },
    ],
  });
  assert.match(text, /^messages\[3\]\{id,thread_id,from,kind,body,at\}:$/m);
});

test("deeply nested structures round-trip", () => {
  verify({ nested: { deep: { deeper: { list: [1, { x: [true, null] }] } } } });
  verify({ a: [[1], { b: 2 }, "x", null, [[/* nested empty */]]] });
  verify([{ outer: [{ inner: [{ a: 1 }, { a: 2 }] }] }]);
});

// The reference encoder is the arbiter of spec-correct output, so on every
// shape both writers can express, the bytes must agree — not merely decode
// alike. Excluded by design: payloads with dropped undefined keys (the
// reference writes `key: null`) and the compressed forms covered above.
test("output matches the reference encoder byte-for-byte on shared shapes", () => {
  const shared = [
    WAIT_LIST,
    WAIT_TABULAR,
    ROSTER,
    REGISTERED,
    "hello",
    "",
    "null",
    42,
    -0,
    1e21,
    true,
    null,
    {},
    [],
    [1, 2, 3],
    [{ a: 1 }, { a: 2 }],
    [{}, {}],
    { a: {} },
    { a: [] },
    { a: [{}, []] },
    { a: NaN, b: Infinity },
    { k: [{ a: 1, b: 2 }, { b: 4, a: 3 }] },
    { k: [{ first: [1, 2], second: "s" }] },
    { k: [{ deep: { x: 1 }, after: [1, { z: 9 }] }, 7] },
    { nested: { deep: { deeper: { list: [1, { x: [true, null] }] } } } },
  ];
  for (const value of shared) assert.equal(encodeToon(value), referenceEncode(value));
});
