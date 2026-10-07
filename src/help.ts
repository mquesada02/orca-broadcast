import { flagsOf, GENERIC_FLAGS, isCommand, type Command, type FlagSpec } from './flags.js';

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

const GROUP_PURPOSE = 'Save, list, show and remove named filters';

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

export function topHelp(): string {
  const commands = Object.entries({ ...PURPOSE, group: GROUP_PURPOSE }).map(([name, text]) => `  ${name.padEnd(11)}${text}\n`).join('');
  return `Usage: orca-broadcast <command> [flags]\n\nCommands:\n${commands}\nOptions differ per command: run \`orca-broadcast <command> --help\` for its options.\n`;
}

export function helpFor(topic: HelpTopic): string {
  return topic === 'group' ? groupHelp() : topic === null ? topHelp() : commandHelp(topic);
}

/** The topic of the first word, or null when it is not a command. */
export const helpTopicOf = (positionals: string[]): HelpTopic => {
  const [first] = positionals;
  return first === 'group' ? 'group' : isCommand(first) ? first : null;
};
