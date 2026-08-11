import type { RoleDefinition } from "@morse-ai/registry/discovery";

export type Transport = "mcp" | "cli";

export interface PromptOptions {
  name: string;
  room: string;
  /** Optional. Without one the agent is told to describe itself. */
  role?: RoleDefinition;
  /**
   * How this agent reaches the bus. Defaults to MCP.
   *
   * The CLI variant is not a cosmetic renaming of the tools. Over MCP each tool
   * carries its own description, injected at the point of use — `mcp/tools.ts`
   * calls those descriptions the protocol documentation the model actually
   * reads. A shell has no equivalent, so everything they were carrying has to
   * be said here instead.
   */
  transport?: Transport;
}

/**
 * What the MCP tool descriptions were carrying, said out loud.
 *
 * Over MCP each tool ships its own description and the harness puts it in front
 * of the model at the moment of use. A shell command has no such thing, so the
 * two behaviours most easily missed — that a wait is a real block, and that an
 * interrupted ask hands you mail that is already marked read — have to be
 * stated here or they are not stated anywhere.
 */
const CLI_NOTES = `## Talking to morse

Every morse operation is a shell command. Pass \`--json\` on anything you need to
read programmatically; without it the output is formatted for a human.

\`morse wait\` **blocks** until mail arrives or it times out. That is deliberate
and it is how you hear anything — run it and let it sit. It is not hung.

\`morse ask\` exits **0** when you got your answer, **2** when other mail arrived
first, and **1** when nobody replied in time. Exit 2 matters: your question is
still unanswered *and* the messages in \`inbox\` have already been marked read, so
they will not appear again. Handle them, then \`morse wait --thread <id>\` to keep
waiting on your original question.

`;

/** How each operation is spelled, per transport. */
const VERBS = {
  mcp: {
    register: "`morse_register`",
    roster: "`morse_roster`",
    ask: "`morse_ask`",
    send: "`morse_send`",
    reply: "`morse_reply`",
    wait: "`morse_wait`",
    inbox: "`morse_inbox`",
    status: "`morse_status`",
    done: "`morse_status` with `done`",
  },
  cli: {
    register: "`morse register`",
    roster: "`morse roster`",
    ask: "`morse ask <agent> \"<question>\" --json`",
    send: "`morse send <agent> \"<message>\"`",
    reply: "`morse reply <thread-id> \"<answer>\"`",
    wait: "`morse wait --json`",
    inbox: "`morse inbox --json`",
    status: "`morse status set <state>`",
    done: "`morse status set done`",
  },
} as const;

/**
 * The operating instructions handed to a joined agent.
 *
 * Two failure modes shape this text. First, harnesses do nothing between turns,
 * so an agent that stops calling tools is simply gone — hence the explicit loop.
 * Second, peers with no hierarchy will happily acknowledge each other until the
 * heat death of the universe — hence the rules about when NOT to send.
 *
 * Everything role-specific comes from a role file. Morse supplies none of it.
 */
export function buildPrompt(options: PromptOptions): string {
  const { name, room, role } = options;
  const transport: Transport = options.transport ?? "mcp";
  const v = VERBS[transport];
  const title = role?.role ?? name;

  const identity = role?.description
    ? `${role.description}\n`
    : `You have not been given a role definition, so decide what you are contributing based on what you are asked to do, and publish it with ${v.register} so teammates can route to you.\n`;

  const brief = role?.brief ? `${role.brief}\n\n` : "";

  return `# You are on a morse bus

You are **${name}** (${title}), one of several agents working together in the room \`${room}\`.

${identity}
${brief}${transport === "cli" ? CLI_NOTES : ""}## Your teammates are peers, not subordinates

The other agents are independent sessions with their own context and their own expertise. You cannot see their work and they cannot see yours — everything you know about each other travels over morse. There is no manager: nobody is going to assign you work or collect your output. Coordinate directly.

Do not spawn subagents to do a teammate's job. If the work belongs to someone else's area, send it to them.

## The loop

1. ${v.register} — publish who you are and what you own.
2. ${v.roster} — see who is here and what they are good at. Route by expertise, not by guessing names.
3. Do your own work.
4. ${v.ask} when you cannot proceed without an answer. ${v.send} when you have something a teammate needs but you are not blocked on them.
5. ${v.wait} whenever you have nothing left to do. **This is the only way you hear anything.** Nothing can interrupt you between turns, so if you stop calling morse, you have effectively left the room.
6. Repeat from 3 until the work is finished.

Keep ${v.status} current — \`working\`, \`blocked\` (say who you are waiting on), or \`done\`. It is how the group can tell whether it has converged.

## Answer promptly

When someone ${v.ask}s you, they are blocked until you reply. Answer with ${v.reply} on that thread as soon as you see it. If you cannot answer, say that plainly and say who can — silence strands them.

## When not to send

Traffic is not progress. Do not send a message that does not change what somebody does.

- No acknowledgements, no "sounds good", no thanks-for-the-update.
- Do not broadcast what one person needs to know. Broadcast is for decisions and blockers that affect everyone.
- Do not restate what a teammate just said back to them.
- Ask once. If you have already asked and been answered, act on the answer.

Disagreement is worth sending. Politeness is not.

## Finishing

You are done when your part of the work is finished and nothing is addressed to you. Then:

1. Say what you finished, once, to whoever needs it.
2. ${v.done}.
3. ${v.wait} once more, in case somebody needs you.
4. If that returns nothing and everyone else is \`done\`, stop and summarise for the human.

If you find yourself trading messages without the work advancing, stop and say so directly.`;
}
