import { ROLES } from './filters.js';

export const COMMANDS = ['broadcast', 'pause', 'resume', 'close'] as const;
// The commands that take the filters; the filters of `broadcast` belong to #69.
const FILTERED = ['pause', 'resume', 'close'] as const;
export type Command = (typeof COMMANDS)[number];
export const isCommand = (value: string | undefined): value is Command => COMMANDS.some((name) => name === value);

export class UsageError extends Error {}

interface FlagSpec {
  type: 'boolean' | 'string';
  multiple?: true;
  /** The commands that accept the flag. */
  commands: readonly Command[];
  /** Names the place where the flag applies, when it is not one of these three commands. */
  appliesTo?: string;
}

// One table drives the parser and the "flag not valid here" messages of every command.
const FLAGS: Record<string, FlagSpec> = {
  help: { type: 'boolean', commands: COMMANDS },
  json: { type: 'boolean', commands: COMMANDS },
  file: { type: 'string', commands: ['broadcast'] },
  timeout: { type: 'string', commands: ['pause', 'broadcast'] },
  reason: { type: 'string', commands: ['pause'] },
  yes: { type: 'boolean', commands: ['pause', 'resume', 'broadcast'] },
  repo: { type: 'string', multiple: true, commands: FILTERED },
  worktree: { type: 'string', multiple: true, commands: FILTERED },
  role: { type: 'string', multiple: true, commands: FILTERED },
  run: { type: 'string', multiple: true, commands: FILTERED },
  state: { type: 'string', multiple: true, commands: [], appliesTo: 'broadcast' },
};

export const PARSE_OPTIONS = Object.fromEntries(Object.entries(FLAGS).map(([name, { type, multiple }]) => [name, multiple ? { type, multiple } : { type }]));

export type FlagValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

const joinList = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// Rejects a flag the command does not accept, and a --role value that is not a role.
export function validateFlags(command: Command, values: FlagValues): void {
  for (const [name, spec] of Object.entries(FLAGS)) {
    if (values[name] !== undefined && !spec.commands.includes(command)) {
      throw new UsageError(`--${name} applies only to ${spec.appliesTo ?? joinList(spec.commands)}`);
    }
  }
  for (const role of (values.role as string[] | undefined) ?? []) {
    if (!(ROLES as readonly string[]).includes(role)) throw new UsageError(`invalid --role "${role}": use one of ${ROLES.join(', ')}`);
  }
}
