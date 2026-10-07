import { isRole, ROLES } from './filters.js';
import { GROUP_STATES, isGroupState } from './groups.js';

export const COMMANDS = ['broadcast', 'pause', 'resume', 'close'] as const;
// The commands that take the filters.
const FILTERED = ['broadcast', 'pause', 'resume', 'close'] as const;
export type Command = (typeof COMMANDS)[number];
export const isCommand = (value: string | undefined): value is Command => COMMANDS.some((name) => name === value);

export class UsageError extends Error {}

interface FlagSpec {
  type: 'boolean' | 'string';
  multiple?: true;
  /** The commands that accept the flag. */
  commands: readonly Command[];
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
  state: { type: 'string', multiple: true, commands: ['broadcast'] },
  group: { type: 'string', multiple: true, commands: FILTERED },
};

export const PARSE_OPTIONS = Object.fromEntries(Object.entries(FLAGS).map(([name, { type, multiple }]) => [name, multiple ? { type, multiple } : { type }]));

export type FlagValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

const joinList = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// Rejects a flag the command does not accept, and a --role value that is not a role.
export function validateFlags(command: Command, values: FlagValues): void {
  for (const [name, spec] of Object.entries(FLAGS)) {
    if (values[name] !== undefined && !spec.commands.includes(command)) {
      throw new UsageError(`--${name} applies only to ${joinList(spec.commands)}`);
    }
  }
  if (((values.group as string[] | undefined) ?? []).length > 1) throw new UsageError('use at most one --group');
  checkRoles(values);
  checkStates(values);
}

function checkStates(values: FlagValues): void {
  for (const state of (values.state as string[] | undefined) ?? []) {
    if (!isGroupState(state)) throw new UsageError(`invalid --state "${state}": use one of ${GROUP_STATES.join(', ')}`);
  }
}

function checkRoles(values: FlagValues): void {
  for (const role of (values.role as string[] | undefined) ?? []) {
    if (!isRole(role)) throw new UsageError(`invalid --role "${role}": use one of ${ROLES.join(', ')}`);
  }
}

// The flags of the `group` subcommands: their own table, so the messages of the four send commands do not change.
export function validateGroupArgs(sub: string, rest: string[], values: FlagValues): void {
  const allowed = sub === 'add' ? ['help', 'json', 'repo', 'worktree', 'role', 'run', 'state'] : ['help', 'json'];
  for (const name of Object.keys(FLAGS)) {
    if (values[name] !== undefined && !allowed.includes(name)) throw new UsageError(`--${name} does not apply to group ${sub}`);
  }
  const arity = sub === 'list' ? 0 : 1;
  if (rest.length < arity) throw new UsageError(`group ${sub} needs a group name`);
  if (rest.length > arity) throw new UsageError(`group ${sub} takes ${arity === 0 ? 'no argument' : 'one group name'}`);
  checkRoles(values);
}
