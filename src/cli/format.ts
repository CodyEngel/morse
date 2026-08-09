import type { Agent, AgentStatus, Message } from "../store.js";

const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);

export const dim = wrap("2");
export const bold = wrap("1");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const magenta = wrap("35");
export const cyan = wrap("36");

const AGENT_COLORS = [cyan, magenta, green, yellow, blue, red];

/** Stable per-name colour so a room's log is scannable at a glance. */
export function agentColor(name: string): (text: string) => string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length]!;
}

const STATUS_COLORS: Record<AgentStatus, (text: string) => string> = {
  idle: dim,
  working: green,
  blocked: yellow,
  done: blue,
  offline: dim,
};

/**
 * A terminal status has to survive going offline. Collapsing every absent agent
 * to "offline" makes a room that converged look exactly like one that died
 * mid-task, and by then the process is gone, so the badge is the only surviving
 * evidence of how the session ended: `done · offline` means stop looking,
 * `working · offline` means work was dropped and someone has to redo it.
 *
 * The distinction lives in the words rather than the dimming, so it still reads
 * when output is piped to a file or a CI log — which is exactly when someone is
 * reading it for triage.
 */
export function statusBadge(agent: Agent): string {
  // A cleanly-departed agent has had its status overwritten with 'offline' in
  // the store, so there is no last-known state left to show.
  if (agent.status === "offline") return dim("offline");

  const paint = STATUS_COLORS[agent.status];
  if (agent.online) return paint(agent.status);

  // Running but not heartbeating: the session exists and its inbox is filling
  // up, but nobody has given it a turn, so it is not listening. Calling that
  // "offline" sends teammates looking for a crash that never happened.
  if (agent.alive) return `${paint(agent.status)}${yellow(" · not listening")}`;

  return `${paint(agent.status)}${dim(" · offline")}`;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatMessage(message: Message): string {
  const color = agentColor(message.sender);
  const to = message.to.includes("*") ? "all" : message.to.join(", ");
  const arrow = message.kind === "system" ? "" : dim(` → ${to}`);
  const head = `${dim(clock(message.createdAt))} ${color(bold(message.sender))}${arrow}`;
  const tag =
    message.kind === "ask" ? yellow(" [ask]") : message.kind === "reply" ? green(" [reply]") : "";
  const subject = message.subject ? ` ${bold(message.subject)}` : "";
  const body = message.body
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `${head}${tag}${subject}\n${body}`;
}

export function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
