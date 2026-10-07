import { flagsOf, isCommand, type Command, type FlagSpec } from './flags.js';

/** What a help request or a usage error is about: one command, the `group` commands, or nothing known. */
export type HelpTopic = Command | 'group' | null;

const PURPOSE: Record<Command, string> = {
  broadcast: 'Send one line of text to every working or done Claude Code agent and prove each one handled it',
  pause: 'Ask every working Claude Code agent to stop at a clean point and prove it did',
  resume: 'Tell every paused agent to continue and prove it did',
  close: 'Abandon the open run or broadcast without resuming it; nothing is sent',
};

const DETAILS: Record<Command, string[]> = {
  broadcast: [
    'An agent counts as acked when its new last reply ends with ORCA-ACK <token>. The text is one line of at most 1000 characters.',
    'Exit 0 if all acked, 1 if any did not, 2 on a refusal.',
    'With no text, or the same text, it continues the open broadcast: same token, a fresh --timeout, and it sends again only to agents that never got the message. Filters then narrow the recorded targets.',
  ],
  pause: [
    'Exit 0 if all agents confirmed, 1 if any is unconfirmed. A second pause widens the open run.',
  ],
  resume: [
    'Exit 0 if the run closed (or there was nothing to resume), 1 if any agent is pending. Filters only narrow the run; they never add agents.',
  ],
  close: [
    'Pending agents become abandoned. Exit 0, also when there is nothing to close. Filters only narrow the run; the record stays open while others are pending.',
  ],
};

const GROUP_USAGE = [
  'orca-broadcast group add <name> [filters] [--json]',
  'orca-broadcast group list [--json]',
  'orca-broadcast group show <name> [--json]',
  'orca-broadcast group remove <name> [--json]',
];

// The two flags every page ends with, so a command's own flags come first.
const GENERIC_FLAGS = new Set(['help', 'json']);

const flagUsage = ([name, spec]: [string, FlagSpec]) => `[--${name}${spec.arg ? ` ${spec.arg}` : ''}]`;

function usageOf(command: Command): string {
  const flags = flagsOf(command).filter(([name]) => !GENERIC_FLAGS.has(name));
  const parts = ['orca-broadcast', command];
  if (command === 'broadcast') parts.push('["<text>" | --file <path>]');
  if (flags.some(([, spec]) => spec.filter)) parts.push('[filters]');
  parts.push(...flags.filter(([name, spec]) => !spec.filter && name !== 'file').map(flagUsage));
  return parts.join(' ');
}

/** The usage line (or lines) a usage error prints under its message. */
export function usageLine(topic: HelpTopic): string {
  if (topic === 'group') return `Usage: ${GROUP_USAGE.join('\n       ')}\n`;
  if (topic === null) return topHelp();
  return `Usage: ${usageOf(topic)}\n`;
}

const TOP_USAGE = 'Usage: orca-broadcast <command> [flags]\n';

const flagLines = (entries: [string, FlagSpec][], note: (spec: FlagSpec) => string | undefined, help: (spec: FlagSpec) => string): string => {
  const ordered = [...entries.filter(([name]) => !GENERIC_FLAGS.has(name)), ...entries.filter(([name]) => GENERIC_FLAGS.has(name))];
  return ordered
    .map(([name, spec]) => {
      const extra = note(spec);
      return `  --${name}${spec.arg ? ` ${spec.arg}` : ''}\n      ${help(spec)}${extra ? `\n      ${extra}` : ''}\n`;
    })
    .join('');
};

export function commandHelp(command: Command): string {
  const body = DETAILS[command].map((line) => `${line}\n`).join('');
  return `${usageLine(command)}\n${PURPOSE[command]}.\n${body}\nFlags:\n${flagLines(flagsOf(command), (spec) => spec.notes?.[command], (spec) => spec.help)}`;
}

export function groupHelp(): string {
  const note = 'list, show and remove take only --json and --help.\n';
  return `${usageLine('group')}\nSave, list, show and remove named filters. add checks that every value resolves now; show lists the agents the group matches now. They only read Orca and send nothing.\n${note}\nFlags of group add:\n${flagLines(flagsOf('group add'), () => undefined, (spec) => spec.groupHelp ?? spec.help)}`;
}

const TOP_PURPOSE: [string, string][] = [
  ['broadcast', 'Send one line of text to the agents and prove each one acknowledged it'],
  ['pause', 'Ask the working agents to stop at a clean point and prove it'],
  ['resume', 'Tell the paused agents to continue and prove it'],
  ['close', 'Abandon the open run or broadcast without resuming it'],
  ['group', 'Save, list, show and remove named filters'],
];

export function topHelp(): string {
  const commands = TOP_PURPOSE.map(([name, text]) => `  ${name.padEnd(11)}${text}\n`).join('');
  return `${TOP_USAGE}\nCommands:\n${commands}\nOptions differ per command: run \`orca-broadcast <command> --help\` for its options.\n`;
}

export function helpFor(topic: HelpTopic): string {
  return topic === 'group' ? groupHelp() : topic === null ? topHelp() : commandHelp(topic);
}

/** The topic of the first word, or null when it is not a command. */
export const helpTopicOf = (positionals: string[]): HelpTopic => {
  const [first] = positionals;
  return first === 'group' ? 'group' : isCommand(first) ? first : null;
};
