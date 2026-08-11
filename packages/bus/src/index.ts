/**
 * `@morse-ai/bus` — the message half of morse.
 *
 * Rooms, delivery, threads, read cursors, and the blocking waits that let a
 * turn-based agent hear anything at all. Zero dependencies: it talks to a
 * registry through the `Registry` interface it defines itself, so anything with
 * those four methods will do. `@morse-ai/registry` is one such thing.
 */
export {
  Bus,
  BROADCAST,
  normalizeRecipients,
  newThreadId,
  type BusOptions,
  type Message,
  type MessageKind,
  type SendInput,
} from "./bus.js";
export { unregistered, type Registry, type Status } from "./registry.js";
export { waitForInbox, waitForReply, type AskResult, type AskOutcome, type WaitOptions } from "./wait.js";
export { openDb, dbPath, resetDb, now } from "./db.js";
export {
  BUS_TOOLS,
  busHandler,
  renderMessage,
  requireString,
  toStringArray,
  hintForAsk,
  type ToolDefinition,
  type ToolSession,
} from "./mcp.js";
