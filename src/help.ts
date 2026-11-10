import { flagsOf, GENERIC_FLAGS, isCommand, type Command, type FlagSpec } from './flags.js';

/** What a help request or a usage error is about: one command, the `group` or `roster` commands, or nothing known. */
export type HelpTopic = Command | 'group' | 'roster' | null;

const PURPOSE: Record<Command, string> = {
  broadcast: 'Send text (several lines allowed) to every working or done Claude Code agent and prove each one handled it',
  pause: 'Ask every working Claude Code agent to stop at a clean point and prove it did',
  resume: 'Tell every paused agent to continue and prove it did',
  close: 'Abandon the open run, broadcast or recovery without resuming it; nothing is sent',
  recover: 'Show which agents were alive before a restart or a crash, and which came back',
};

const DETAILS: Record<Command, string[]> = {
  broadcast: [
    'An agent counts as acked when its new last reply ends with ORCA-ACK <token>. The text has at most 4000 characters; a newline is allowed, any other control character is not.',
    'Exit 0 if all acked, 1 if any did not, 2 on a refusal.',
    'With no text, or the same text, it continues the open broadcast: same token, a fresh --timeout, and it sends again only to agents that never got the message. Filters then narrow the recorded targets.',
  ],
  pause: [
    'Exit 0 if all agents confirmed, 1 if any is unconfirmed. A second pause widens the open run.',
  ],
  resume: [
    'Exit 0 if every selected agent is resumed or gone (or there was nothing to resume), 1 if any selected agent is still pending. Filters only narrow the run; they never add agents.',
    'The agent of the session that runs resume (its ORCA_PANE_KEY) is marked resumed with reason self and gets no message; from any other session it gets CONTINUE like the others.',
  ],
  close: [
    'Pending agents become abandoned. Exit 0, also when there is nothing to close. Filters only narrow the run; the record stays open while others are pending.',
  ],
  recover: [
    'Reads the roster saved before the restart, matches each agent to a live session by Claude session ID, and shows what is restored, missing or failed. It asks once before it acts; the filters select the part of the fleet to recover.',
    'After a yes it restarts every missing agent that is not a worker with claude --resume, coordinators first, and waits for each one to appear in Orca; it never starts a session that a live process holds. It then sends the continue prompt to each live agent whose last state was working or waiting and to each coordinator that has a missing worker, and waits for the ORCA-ACK proof, as broadcast does. Answering no prints the report, writes no record and exits 1. With an open pause run it sends no prompt and writes no recovery record: it stores the outcome and each coordinator\'s missing workers in the run, and resume adds those workers to the CONTINUE message.',
    'Exit 0 if every row is restored, restarted, acked, left-to-coordinator or abandoned (or there is nothing to recover), 1 if any row is pending, gone, no-coordinator or failed, 2 on a refusal.',
  ],
};

const GROUP_USAGE = [
  'orca-broadcast group add <name> [filters] [--json]',
  'orca-broadcast group list [--json]',
  'orca-broadcast group show <name> [--json]',
  'orca-broadcast group remove <name> [--json]',
];

const GROUP_PURPOSE = 'Save, list, show and remove named filters';

const ROSTER_USAGE = ['orca-broadcast roster save [--json]'];

const ROSTER_PURPOSE = 'Save a snapshot of the live Claude Code agents';

const COMPLETION_PURPOSE = 'Print the bash Tab completion script: add eval "$(orca-broadcast completion bash)" to ~/.bashrc';

const flagHead = (name: string, spec: FlagSpec) => `--${name}${spec.arg ? ` ${spec.arg}` : ''}`;
const flagUsage = ([name, spec]: [string, FlagSpec]) => `[${flagHead(name, spec)}]`;

function usageOf(command: Command): string {
  const flags = flagsOf(command).filter(([name]) => !GENERIC_FLAGS.includes(name));
  const parts = ['orca-broadcast', command];
  if (command === 'broadcast') parts.push('["<text>" | --file <path>]');
  if (flags.some(([, spec]) => spec.filter)) parts.push('[filters]');
  parts.push(...flags.filter(([name, spec]) => !spec.filter && name !== 'file').map(flagUsage));
  return parts.join(' ');
}

/** The usage line (or lines) a usage error prints under its message. */
export function usageLine(topic: HelpTopic): string {
  if (topic === 'group') return `Usage: ${GROUP_USAGE.join('\n       ')}\n`;
  if (topic === 'roster') return `Usage: ${ROSTER_USAGE.join('\n       ')}\n`;
  if (topic === null) return topHelp();
  return `Usage: ${usageOf(topic)}\n`;
}

const flagLines = (target: Command | 'group add'): string =>
  flagsOf(target)
    .map(([name, spec]) => {
      const help = (target === 'group add' && spec.groupHelp) || spec.help;
      const note = target === 'group add' ? undefined : spec.notes?.[target];
      return `  ${flagHead(name, spec)}\n      ${help}${note ? `\n      ${note}` : ''}\n`;
    })
    .join('');

export function commandHelp(command: Command): string {
  const body = DETAILS[command].map((line) => `${line}\n`).join('');
  return `${usageLine(command)}\n${PURPOSE[command]}.\n${body}\nFlags:\n${flagLines(command)}`;
}

export function groupHelp(): string {
  return `${usageLine('group')}\n${GROUP_PURPOSE}. add checks that every value resolves now; show lists the agents the group matches now. They only read Orca and send nothing.\nlist, show and remove take only --json and --help.\n\nFlags of group add:\n${flagLines('group add')}`;
}

export function rosterHelp(): string {
  return `${usageLine('roster')}\n${ROSTER_PURPOSE}, one file per Orca runtime in the state folder (the newest 5 are kept). save reads Orca and Claude processes and sends nothing; it takes no lock. It never stores prompt or reply text.\nExit 0 if saved, 1 if it could not save (the reason is printed), 2 on a usage error.\n\nFlags:\n${flagsOf('group add').filter(([name]) => GENERIC_FLAGS.includes(name)).map(([name, spec]) => `  ${flagHead(name, spec)}\n      ${spec.help}\n`).join('')}`;
}

export function topHelp(): string {
  const commands = Object.entries({ ...PURPOSE, group: GROUP_PURPOSE, roster: ROSTER_PURPOSE, completion: COMPLETION_PURPOSE }).map(([name, text]) => `  ${name.padEnd(11)}${text}\n`).join('');
  return `Usage: orca-broadcast <command> [flags]\n\nCommands:\n${commands}\nOptions differ per command: run \`orca-broadcast <command> --help\` for its options.\n`;
}

export function helpFor(topic: HelpTopic): string {
  return topic === 'group' ? groupHelp() : topic === 'roster' ? rosterHelp() : topic === null ? topHelp() : commandHelp(topic);
}

/** The topic of the first word, or null when it is not a command. */
export const helpTopicOf = (positionals: string[]): HelpTopic => {
  const [first] = positionals;
  return first === 'group' || first === 'roster' ? first : isCommand(first) ? first : null;
};
