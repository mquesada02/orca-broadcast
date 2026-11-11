import { isRole, ROLES } from './filters.js';
import { GROUP_STATES, isGroupState } from './groups.js';
import { PRESET_NAMES } from './reasons.js';

export const COMMANDS = ['broadcast', 'pause', 'resume', 'close', 'recover'] as const;
// The commands that take the filters.
const FILTERED = ['broadcast', 'pause', 'resume', 'close', 'recover'] as const;
export type Command = (typeof COMMANDS)[number];
export const isCommand = (value: string | undefined): value is Command => COMMANDS.some((name) => name === value);

export class UsageError extends Error {}

export interface FlagSpec {
  type: 'boolean' | 'string';
  multiple?: true;
  /** The commands that accept the flag. */
  commands: readonly Command[];
  /** The value as help shows it, such as `<path>`; omitted for a switch. */
  arg?: string;
  /** One line for the help of every command that accepts the flag. */
  help: string;
  /** Where the flag means something different on one command. */
  notes?: Partial<Record<Command, string>>;
  /** True for the flags that select agents; help groups them as `[filters]`. */
  filter?: true;
  /** True for the flags `group add` accepts (the `group` call is not a `Command`). */
  groupAdd?: true;
  /** The help line of the flag on `group add`, when it differs. */
  groupHelp?: string;
}

// One table drives the parser and the "flag not valid here" messages of every command.
const NARROWS_RUN = 'Only narrows the recorded agents of the open run.';
const NEEDS_YES = 'It never asks for confirmation, so --yes is required.';
const STATE_KIND_SKIPPED = "A group's state kind is skipped (one line on stderr per group). A group with only a state kind is dropped from a union, and refused when every group is like that.";
const NARROWS_RECOVERY = 'Narrows the agents to recover.';
const NARROWING_NOTES = { resume: NARROWS_RUN, close: NARROWS_RUN, recover: NARROWS_RECOVERY } as const;

const FLAGS: Record<string, FlagSpec> = {
  help: { type: 'boolean', commands: COMMANDS, help: 'Show this help' },
  json: {
    type: 'boolean',
    commands: COMMANDS,
    help: 'Print one JSON object on stdout and nothing on stderr (except the line about each skipped group state kind)',
    notes: { broadcast: NEEDS_YES, pause: NEEDS_YES, resume: NEEDS_YES, recover: NEEDS_YES },
  },
  file: { type: 'string', arg: '<path>', commands: ['broadcast'], help: 'Read the text from a file instead of the command line; give the text or --file, not both' },
  timeout: {
    type: 'string',
    arg: '<n>s|m|h',
    commands: ['pause', 'broadcast', 'recover'],
    help: 'How long to wait (default 10m)',
    notes: { pause: 'Waits for confirmations.', broadcast: 'Waits for acks; each re-run waits a fresh time.', recover: 'Bounds the whole command from its start; the wait for the confirmation does not count.' },
  },
  reason: {
    type: 'string',
    arg: '<name>',
    commands: ['pause'],
    help: `Why you pause: ${PRESET_NAMES.join(', ')}. Changes only the first sentence of the pause and continue messages (default: neutral)`,
  },
  yes: {
    type: 'boolean',
    commands: ['pause', 'resume', 'broadcast', 'recover'],
    help: 'Skip the confirmation before anything is sent; without a terminal (a script, an agent shell) the command refuses to send unless you pass it',
  },
  'keep-tabs': {
    type: 'boolean',
    commands: ['recover'],
    help: 'Keep the restored tabs: do not clear a worktree before the first start there',
  },
  repo: {
    type: 'string',
    arg: '<id|path|name>',
    multiple: true,
    commands: FILTERED,
    filter: true,
    groupAdd: true,
    help: 'Agents in that repo; repeat the flag for several values',
    notes: NARROWING_NOTES,
  },
  worktree: {
    type: 'string',
    arg: '<path|id|name>',
    multiple: true,
    commands: FILTERED,
    filter: true,
    groupAdd: true,
    help: 'Agents in that worktree; a name is looked up in the --repo values',
    notes: NARROWING_NOTES,
  },
  role: {
    type: 'string',
    arg: `<${ROLES.join('|')}>`,
    multiple: true,
    commands: FILTERED,
    filter: true,
    groupAdd: true,
    help: 'Agents with that role',
    notes: NARROWING_NOTES,
  },
  run: {
    type: 'string',
    arg: '<id>',
    multiple: true,
    commands: FILTERED,
    filter: true,
    groupAdd: true,
    help: 'Agents of that orchestration run (an exact run id)',
    notes: NARROWING_NOTES,
  },
  state: {
    type: 'string',
    arg: `<${GROUP_STATES.join('|')}>`,
    multiple: true,
    commands: ['broadcast'],
    filter: true,
    groupAdd: true,
    help: 'Agents in that live state (broadcast only)',
    groupHelp: 'Agents in that live state; the group applies it on broadcast only',
    notes: { broadcast: 'On a re-run it matches the live state of the recorded targets.' },
  },
  group: {
    type: 'string',
    arg: '<name>',
    multiple: true,
    commands: FILTERED,
    filter: true,
    help: 'Use a saved group; repeat it for the union of the groups. Other filters narrow every group',
    notes: {
      pause: STATE_KIND_SKIPPED,
      resume: `${STATE_KIND_SKIPPED} ${NARROWS_RUN}`,
      close: `${STATE_KIND_SKIPPED} ${NARROWS_RUN}`,
      recover: `${STATE_KIND_SKIPPED} ${NARROWS_RECOVERY}`,
    },
  },
};

export const GENERIC_FLAGS = ['help', 'json'];

/** The spec of one flag by name, or undefined for an unknown name. */
export const specOf = (name: string): FlagSpec | undefined => (Object.hasOwn(FLAGS, name) ? FLAGS[name] : undefined);

/** The flags a command accepts, or the flags `group add` accepts: the command's own in table order, then `json` and `help`. */
export const flagsOf = (target: Command | 'group add'): [string, FlagSpec][] => {
  const own = Object.entries(FLAGS).filter(([name, spec]) => !GENERIC_FLAGS.includes(name) && (target === 'group add' ? spec.groupAdd : spec.commands.includes(target)));
  return [...own, ...GENERIC_FLAGS.map((name): [string, FlagSpec] => [name, FLAGS[name]!])];
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
  checkRoles(values);
  checkStates(values);
}

export function checkStates(values: FlagValues): void {
  for (const state of (values.state as string[] | undefined) ?? []) {
    if (!isGroupState(state)) throw new UsageError(`invalid --state "${state}": use one of ${GROUP_STATES.join(', ')}`);
  }
}

function checkRoles(values: FlagValues): void {
  for (const role of (values.role as string[] | undefined) ?? []) {
    if (!isRole(role)) throw new UsageError(`invalid --role "${role}": use one of ${ROLES.join(', ')}`);
  }
}

// `roster save` takes no argument and only the generic flags.
export function validateRosterArgs(rest: string[], values: FlagValues): void {
  for (const name of Object.keys(FLAGS)) {
    if (values[name] !== undefined && !GENERIC_FLAGS.includes(name)) throw new UsageError(`--${name} does not apply to roster save`);
  }
  if (rest.length > 0) throw new UsageError('roster save takes no argument');
}

// The flags of the `group` subcommands: their own table, so the messages of the four send commands do not change.
export function validateGroupArgs(sub: string, rest: string[], values: FlagValues): void {
  const allowed = sub === 'add' ? flagsOf('group add').map(([name]) => name) : GENERIC_FLAGS;
  for (const name of Object.keys(FLAGS)) {
    if (values[name] !== undefined && !allowed.includes(name)) throw new UsageError(`--${name} does not apply to group ${sub}`);
  }
  const arity = sub === 'list' ? 0 : 1;
  if (rest.length < arity) throw new UsageError(`group ${sub} needs a group name`);
  if (rest.length > arity) throw new UsageError(`group ${sub} takes ${arity === 0 ? 'no argument' : 'one group name'}`);
  checkRoles(values);
}
