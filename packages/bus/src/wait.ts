import type { Bus, Message } from "./bus.js";

export interface WaitOptions {
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_POLL_MS = 200;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Park until something lands in `name`'s inbox, or the timeout expires.
 *
 * This is how an idle agent hears anything at all: harnesses are turn-based and
 * do nothing between turns, so the agent voluntarily blocks inside a tool call
 * instead of waiting for a push it has no way to receive. Each poll doubles as a
 * heartbeat, which is what keeps a parked agent showing as online to its peers.
 */
export async function waitForInbox(
  bus: Bus,
  room: string,
  name: string,
  opts: WaitOptions,
): Promise<Message[]> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + opts.timeoutMs;

  for (;;) {
    await bus.heartbeat(room, name);
    const messages = bus.inbox(room, name);
    if (messages.length > 0) return messages;
    if (opts.signal?.aborted) return [];
    const remaining = deadline - Date.now();
    if (remaining <= 0) return [];
    await sleep(Math.min(pollMs, remaining), opts.signal);
  }
}

export type AskOutcome = "replied" | "interrupted" | "timeout";

export interface AskResult {
  outcome: AskOutcome;
  reply?: Message;
  /** Traffic that arrived while waiting and is not the reply. */
  inbox: Message[];
}

/**
 * Park until `threadId` gets a reply — but return early if *other* mail arrives.
 *
 * The early return is not a convenience, it is deadlock avoidance: two agents
 * that ask each other something at the same moment would otherwise both block
 * forever, each waiting on a peer that is itself parked.
 */
export async function waitForReply(
  bus: Bus,
  room: string,
  name: string,
  threadId: string,
  afterId: number,
  opts: WaitOptions,
): Promise<AskResult> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + opts.timeoutMs;
  const other: Message[] = [];

  for (;;) {
    await bus.heartbeat(room, name);

    // Drain the whole batch before deciding. inbox() has already moved the
    // cursor past every message it returned, so bailing out mid-batch on the
    // reply would silently drop anything ordered after it — unread, and now
    // unreachable.
    const delivered = bus.inbox(room, name);
    let reply: Message | undefined;
    for (const message of delivered) {
      if (!reply && message.threadId === threadId && message.id > afterId) reply = message;
      else other.push(message);
    }
    if (reply) return { outcome: "replied", reply, inbox: other };

    // Safety net for a reply posted to the thread without addressing us.
    if (other.length === 0) {
      const stray = bus.findReply(room, threadId, afterId, name);
      if (stray) return { outcome: "replied", reply: stray, inbox: other };
    }

    if (other.length > 0) return { outcome: "interrupted", inbox: other };
    if (opts.signal?.aborted) return { outcome: "timeout", inbox: other };

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { outcome: "timeout", inbox: other };
    await sleep(Math.min(pollMs, remaining), opts.signal);
  }
}
