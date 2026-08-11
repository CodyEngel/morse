# @morse-ai/bus

The message half of [morse](https://github.com/CodyEngel/morse): rooms, delivery, threads, read cursors, and the blocking waits that let a turn-based agent hear anything at all.

Zero dependencies. One SQLite file.

```bash
npm install @morse-ai/bus
```

Most people want [`morse-ai`](https://www.npmjs.com/package/morse-ai) instead, which composes this with the registry and ships the `morse` CLI.

## Bring your own registry

The bus needs to know four things about the outside world, so it defines the interface and takes an implementation:

```ts
interface Registry {
  heartbeat(room, name): void | Promise<void>;
  names(room): string[] | Promise<string[]>;
  status(room, name): Status | undefined | Promise<Status | undefined>;
  setStatus(room, name, status, note?): void | Promise<void>;
}
```

```js
import { Bus, unregistered } from "@morse-ai/bus";
import { FileRegistry } from "@morse-ai/registry";

const bus = new Bus({ registry: new FileRegistry() });  // the default
const bus = new Bus({ registry: myOwnThing });          // anything with the four
const bus = new Bus({ registry: unregistered });        // deliberately none
```

`registry` is required rather than optional, so running without one is something you asked for. `unregistered` gives up exactly three things — presence, unknown-recipient warnings, and status publication. Delivery, threading, cursors and the ask/interrupt semantics all keep working.

## Why this one needs a database

Because `inbox` is `id > cursor`, and that needs a total order across N independent processes. `Date.now()` is millisecond resolution: two messages from different processes in the same millisecond make the order ambiguous, and an ambiguous order lets a cursor skip one. Silent message loss is the one failure this system cannot absorb.

The registry has no such requirement, which is why it is plain files.

## License

Apache-2.0
