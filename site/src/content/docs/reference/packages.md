---
title: Packages
description: The three packages morse ships, and the four-method registry contract that keeps two of them independent.
sidebar:
  order: 4
---

Morse is three packages. Most people want `morse-ai`, which is the product: the
`morse` CLI, the composed MCP server, and the protocol prompt.

| Package | What it is | Depends on |
| --- | --- | --- |
| [`morse-ai`](https://www.npmjs.com/package/morse-ai) | The product. `morse` | both |
| [`@morse-ai/bus`](https://www.npmjs.com/package/@morse-ai/bus) | Messages, delivery, blocking waits. `morse-bus` | nothing |
| [`@morse-ai/registry`](https://www.npmjs.com/package/@morse-ai/registry) | Who exists, what they can do, whether they are here. `morse-registry` | nothing |

The three versions move in lockstep and `morse-ai` pins the other two exactly,
so an installed `morse-ai` can only resolve versions it was tested against.

## The registry is injected, not imported

The two halves do not depend on each other. The bus declares the four methods it
needs from a registry — `heartbeat`, `names`, `status`, `setStatus` — and takes
an implementation at construction, so you can supply your own:

```js
import { Bus, unregistered } from "@morse-ai/bus";
import { FileRegistry } from "@morse-ai/registry";

const bus = new Bus({ registry: new FileRegistry() });  // the default
const bus = new Bus({ registry: myOwnThing });          // anything with the four
const bus = new Bus({ registry: unregistered });        // deliberately none
```

`registry` is required rather than optional, so running without one is something
you asked for rather than defaulted into. Without it you lose presence,
unknown-recipient warnings and status; delivery, threading, cursors and
ask/interrupt keep working.

## Why only one half has a database

Only the message log needs one. Every agent record has exactly one writer — its
own process — so the registry is plain files, one JSON record per agent, and
`last_seen` is the file's mtime.

The log needs SQLite for a different reason than concurrency: `inbox` is
`id > cursor`, and that needs a total order across independent processes.

## Which tools live where

The composed server exposes [ten tools](/reference/mcp-tools/). Three of them —
`morse_register`, `morse_ask` and `morse_wait` — live in `morse-ai` because each
needs both halves at once: they move messages *and* answer with directory state.
The other seven live with the package that implements them.
