import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Interrupted, throwIfAborted } from './abort.js';
import { PromptInterrupted } from './ask.js';
import { broadcast, normaliseText } from './broadcast.js';
import { withLockAndSignals, type GuardOptions, type SignalSource } from './guard.js';
import { createOrcaAdapter } from './orca-adapter.js';
import { close } from './close.js';
import { systemClock } from './clock.js';
import { DEFAULT_TIMEOUT_MS, pause, precheckPause, prelockPause, type PauseDeps } from './pause.js';
import { describeFilters, hasFilters, isFiltered } from './filters.js';
import { isGroupSubcommand, runGroup, type GroupResult } from './group-cmd.js';
import { loadGroups, lookupGroup, resolveGroupsPath, toGroupFilter, type GroupSpec } from './groups.js';
import { checkStates, isCommand, PARSE_OPTIONS, UsageError, validateFlags, validateGroupArgs, validateRosterArgs, type Command, type FlagValues } from './flags.js';
import { isRosterSubcommand, runRosterSave, type RosterResult } from './roster-cmd.js';
import { renderBroadcastProgress, renderBroadcastSelfBlock, renderBroadcastTable, renderCloseTable, renderProgress, renderResumeProgress, renderResumeTable, renderSelfBlock, renderTable, renderUnknownRuns } from './render.js';
import { helpFor, helpTopicOf, usageLine, type HelpTopic } from './help.js';
import { isPreset, PRESET_NAMES } from './reasons.js';
import { resume } from './resume.js';
import { createRecordStore, type StoreOptions } from './store.js';
import type { AgentState, Clock, Confirm, FilterSpec, GroupFilter, OrcaPort, Role, RunSummary } from './types.js';

const CLEAR_LINE = '\r\x1b[K';

// Shows each format character (category Cf, such as U+202E) as \u{HEX}, so a preview cannot read differently from the text sent.
const escapeFormatChars = (text: string): string => text.replace(/\p{Cf}/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`);

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
  /** Present only when stdin and stderr are both a terminal: the one way the shell can ask the user. */
  ask?: (question: string, signal?: AbortSignal) => Promise<string>;
}

export interface CliDeps {
  signals?: SignalSource;
  port?: OrcaPort;
  clock?: Clock;
  newToken?: PauseDeps['newToken'];
  /** The folder a relative `--worktree` path is resolved from. */
  cwd?: string;
  /** Sends a signal to a process; the real `process.kill` when omitted. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** The store's pid, liveness and start-time readers; the real ones when omitted. */
  storeOptions?: StoreOptions;
}

function parseUsage(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: PARSE_OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export function parseTimeout(value: string): number {
  const match = /^(\d+)([smh])$/.exec(value);
  if (!match || Number(match[1]) <= 0) throw new UsageError(`invalid --timeout "${value}": use a positive whole number plus s, m or h, such as 90s`);
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'];
}

export function resolveStateDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const base = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return join(base, 'orca-broadcast');
}

// What the user typed for each filter kind.
const filterSpecOf = (values: FlagValues): FilterSpec => {
  const list = (kind: keyof FilterSpec) => (values[kind] as string[] | undefined) ?? [];
  return { repo: list('repo'), worktree: list('worktree'), role: list('role') as Role[], run: list('run'), state: list('state') as AgentState[] };
};

// The JSON object of a group command: the groups it touched, and no run or record.
function groupJsonLine(command: string, result: Pick<GroupResult, 'outcome' | 'groups'> | null, error: string | null = null): string {
  return `${JSON.stringify({ command, outcome: result?.outcome ?? 'error', exitCode: result ? 0 : 2, error, groups: result?.groups ?? null })}\n`;
}

// The group command a call names, as far as it is known: `group` when the subcommand is missing or unknown.
const groupLabel = (positionals: string[]): string | null => (positionals[0] === 'group' ? (isGroupSubcommand(positionals[1]) ? `group ${positionals[1]}` : 'group') : null);

// The roster command a call names, as far as it is known: `roster` when the subcommand is missing or unknown.
const rosterLabel = (positionals: string[]): string | null => (positionals[0] === 'roster' ? (isRosterSubcommand(positionals[1]) ? `roster ${positionals[1]}` : 'roster') : null);

// The JSON object of a roster command. An error carries `exitCode` and `error`; a skipped save carries its reason in `warnings`.
function rosterJsonLine(command: string, result: RosterResult | null, error: string | null = null): string {
  if (result === null) return `${JSON.stringify({ command, outcome: 'error', exitCode: 2, error, agents: null, warnings: [] })}\n`;
  return `${JSON.stringify({ command, outcome: result.outcome, agents: result.outcome === 'saved' ? result.agents : null, warnings: result.outcome === 'saved' ? [] : [result.reason] })}\n`;
}

function jsonLine(command: Command | null, summary: Pick<RunSummary, 'outcome' | 'exitCode' | 'run' | 'error' | 'record'>): string {
  const { outcome, exitCode, run, error, record } = summary;
  return `${JSON.stringify({ command, outcome, exitCode, run, record: record ?? null, error })}\n`;
}

// Lists the targets on stderr and asks once. Ctrl-C at the prompt counts as an interrupt, like SIGTERM.
function confirmOnTerminal(io: CliIo, ask: NonNullable<CliIo['ask']>): Confirm {
  return async (targets, signal, details) => {
    if (io.isTTY) io.stderr(CLEAR_LINE);
    io.stderr(targets.map((t) => `  ${t.repo}/${t.worktree} (${t.role})\n`).join(''));
    if (details) io.stderr(`\nMessage:\n  ${escapeFormatChars(details.message)}\n${details.self ? `\nNot sent to this session: ${details.self.repo}/${details.self.worktree} (${details.self.role})\n` : ''}\n`);
    let answer: string;
    try {
      answer = await ask(`Send to ${targets.length} ${targets.length === 1 ? 'agent' : 'agents'}? [y/N] `, signal);
    } catch (error) {
      if (error instanceof PromptInterrupted) throw new Interrupted(AbortSignal.abort('SIGINT'));
      throw error;
    }
    throwIfAborted(signal);
    return /^y(es)?$/i.test(answer.trim());
  };
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read --file ${path}: ${(error as Error).message}`);
  }
}

// What `broadcast` prints, and what `close` prints when it closed or narrowed a broadcast. The session that runs `broadcast` shows only on the self line.
function renderBroadcastOutput(command: Command | null, summary: RunSummary, filterLine: string, selfPaneKey: string | undefined): string {
  const self = summary.broadcastSelf ? `${renderBroadcastSelfBlock(summary.broadcastSelf)}\n` : '';
  if (summary.outcome === 'nothing-to-do') return `nothing to ${command === 'broadcast' ? 'broadcast' : 'close'}\n${filterLine}${self}`;
  const record = summary.record;
  const heading = command !== 'close' ? '' : record?.status === 'closed' ? `closed broadcast ${record.id}\n` : `broadcast ${record?.id} stays open: ${summary.abandoned} ${summary.abandoned === 1 ? 'target' : 'targets'} abandoned\n`;
  const targets = (record?.targets ?? []).filter((t) => command === 'close' || t.paneKey !== selfPaneKey);
  return `${heading}${renderBroadcastTable(targets)}${self}`;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps = {}): Promise<number> {
  // Read from the raw argv so that an argument parse failure still gets a JSON answer.
  const json = argv.includes('--json');
  let command: Command | null = null;
  // The first words of argv until the parser has run: enough to answer a failed parse of a group call in the group shape.
  let group = groupLabel(argv.filter((arg) => !arg.startsWith('-')));
  let roster = rosterLabel(argv.filter((arg) => !arg.startsWith('-')));
  // What a usage error prints under its message; refined once the parser has run.
  let topic: HelpTopic = helpTopicOf(argv.filter((arg) => arg === 'group' || arg === 'roster' || isCommand(arg)));
  try {
    const { values, positionals } = parseUsage(argv);
    topic = helpTopicOf(positionals);
    if (values.help) {
      io.stdout(helpFor(topic));
      return 0;
    }
    const [name, ...rest] = positionals;
    group = groupLabel(positionals);
    roster = rosterLabel(positionals);
    if (name === 'group') return await mainGroup(rest, values as FlagValues, json, env, io, deps);
    if (name === 'roster') return await mainRoster(rest, values as FlagValues, json, env, io, deps);
    if (name === 'broadcast' && rest.length > 1) throw new UsageError('broadcast takes one text: put it in quotes');
    if (!isCommand(name) || (name !== 'broadcast' && rest.length > 0)) {
      throw new UsageError(positionals.length === 0 ? 'missing command' : `unknown command "${positionals.join(' ')}"`);
    }
    command = name;
    validateFlags(command, values as FlagValues);
    if (rest.length > 0 && values.file !== undefined) throw new UsageError('give the text or --file, not both');
    const reason = values.reason as string | undefined;
    if (reason !== undefined && !isPreset(reason)) throw new UsageError(`invalid --reason "${reason}": use one of ${PRESET_NAMES.join(', ')}`);
    const timeoutMs = values.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseTimeout(values.timeout as string);
    const filterSpec = filterSpecOf(values as FlagValues);
    const filters = hasFilters(filterSpec) ? filterSpec : undefined;
    // The safety switch: nothing is sent without a yes from the user, or --yes. This runs before anything is read, locked or listed.
    const needsConfirm = command !== 'close' && !values.yes;
    if (needsConfirm && (io.ask === undefined || json)) throw new Error('refusing to send without an interactive terminal: pass --yes to confirm');
    const confirm = needsConfirm && io.ask ? confirmOnTerminal(io, io.ask) : undefined;
    const groupFilters = await loadGroupFilters(values.group as string[] | undefined, command, env, io);
    const filtered = isFiltered(filterSpec, groupFilters);
    // No text and no --file is not an error here: the records decide whether there is a broadcast to refuse or to continue.
    const rawText = values.file === undefined ? rest[0] : await readTextFile(values.file as string);
    const text = rawText === undefined ? undefined : normaliseText(rawText);

    const store = createRecordStore(resolveStateDir(env), deps.storeOptions);
    const progressLine = <P>(render: (progress: P) => string) =>
      io.isTTY && !json ? (progress: P) => io.stderr(`${CLEAR_LINE}${render(progress)}`) : undefined;
    const clock = deps.clock ?? systemClock;
    const { cwd } = deps;
    // A plain close never uses the port; only a filtered one needs live listings.
    const port = command === 'close' && !filtered ? null : (deps.port ?? createOrcaAdapter());
    // Only `pause` may stop a broadcast that holds the lock: it is the one urgent command. Its filter and group values are checked before the lock.
    const scope = { port, clock, filters, groups: groupFilters, cwd };
    const guardOptions: GuardOptions =
      command === 'pause' && port
        ? {
            prelock: (signal) => prelockPause({ ...scope, port, signal }),
            handOver: { clock, kill: deps.kill ?? process.kill.bind(process), precheck: (signal) => precheckPause({ ...scope, port, selfPaneKey: env.ORCA_PANE_KEY, signal }) },
          }
        : {};
    const summary = await withLockAndSignals(store, deps.signals ?? process, (signal) => {
      if (!port || command === 'close') return close(store, signal, port && filtered ? { filters: filterSpec, groups: groupFilters, port, clock, cwd } : undefined);
      if (command === 'broadcast') return broadcast(text, timeoutMs, { port, clock, store, newToken: deps.newToken, selfPaneKey: env.ORCA_PANE_KEY, onProgress: progressLine(renderBroadcastProgress), confirm, signal, filters, groups: groupFilters, cwd });
      return command === 'pause'
        ? pause(timeoutMs, { port, clock, store, newToken: deps.newToken, selfPaneKey: env.ORCA_PANE_KEY, reason: reason as PauseDeps['reason'], filters, groups: groupFilters, cwd, onProgress: progressLine(renderProgress), confirm, signal })
        : resume({ port, clock, store, filters, groups: groupFilters, cwd, selfPaneKey: env.ORCA_PANE_KEY, onProgress: progressLine(renderResumeProgress), confirm, signal });
    }, guardOptions);
    if (json) {
      io.stdout(jsonLine(command, summary));
      return summary.exitCode;
    }
    if (io.isTTY && command !== 'close') io.stderr(CLEAR_LINE);

    const filterLine = filtered ? `filters: ${[...groupFilters.map((group) => `--group ${group.name}`), filters && describeFilters(filters)].filter(Boolean).join(' ')}\n` : '';
    // The agents of this output: the rows, and self where the output has a self block.
    const shown = summary.self ? [...summary.rows, summary.self] : summary.rows;
    for (const warning of summary.warnings ?? []) io.stderr(`orca-broadcast: ${warning}\n`);
    if (summary.outcome === 'error') {
      io.stderr(`orca-broadcast: ${summary.error}\n`);
    } else if (command === 'broadcast' || summary.record) {
      io.stdout(renderBroadcastOutput(command, summary, filterLine, env.ORCA_PANE_KEY));
    } else if (summary.outcome === 'nothing-to-do') {
      const selfBlock = summary.self ? `${renderSelfBlock(summary.self)}\n` : '';
      io.stdout(`nothing to ${command}\n${filterLine}${selfBlock}${renderUnknownRuns(shown)}`);
    } else {
      const table = command === 'pause' ? renderTable(summary.rows, summary.self) : command === 'resume' ? renderResumeTable(summary.rows) : renderCloseTable(summary.rows);
      io.stdout(`${table}${renderUnknownRuns(shown)}`);
    }
    return summary.exitCode;
  } catch (error) {
    if (json) {
      io.stdout(group ? groupJsonLine(group, null, (error as Error).message) : roster ? rosterJsonLine(roster, null, (error as Error).message) : jsonLine(command, { outcome: 'error', exitCode: 2, run: null, error: (error as Error).message }));
      return 2;
    }
    io.stderr(`orca-broadcast: ${(error as Error).message}\n`);
    if (error instanceof UsageError) io.stderr(`\n${usageLine(topic)}`);
    return 2;
  }
}

// Loads the groups a command names, each once. For `broadcast` every kind applies. Elsewhere the `state` kind is skipped with one stderr line per group, in text and in --json mode; a group left with no other kind is dropped from the union, and the command is refused when none is left.
async function loadGroupFilters(names: string[] | undefined, command: Command, env: NodeJS.ProcessEnv, io: CliIo): Promise<GroupFilter[]> {
  const unique = [...new Set(names ?? [])];
  if (unique.length === 0) return [];
  const saved = await loadGroups(resolveGroupsPath(env));
  const specs = unique.map((name) => ({ name, spec: lookupGroup(saved, name) }));
  if (command === 'broadcast') return specs;
  const used = specs.map(({ name, spec }) => toGroupFilter(name, spec)).filter((filter) => hasFilters(filter.spec));
  if (used.length === 0) throw new Error(`Group ${unique.join(', ')} only filter${unique.length === 1 ? 's' : ''} by state, which ${command} does not use.`);
  for (const { name, spec } of specs) if (spec.state.length > 0) io.stderr(`orca-broadcast: group ${name}: state filter skipped (${command} does not use it)\n`);
  return used;
}

// `roster save`: runs before the safety switch and the lock, because it never sends and never touches a run. A save that fails is reported, not thrown.
async function mainRoster(rest: string[], values: FlagValues, json: boolean, env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps): Promise<number> {
  const [sub, ...args] = rest;
  if (!isRosterSubcommand(sub)) throw new UsageError(sub === undefined ? 'missing roster subcommand' : `unknown roster subcommand "${sub}"`);
  validateRosterArgs(args, values);
  const store = createRecordStore(resolveStateDir(env), deps.storeOptions);
  const result = await runRosterSave({ port: deps.port ?? createOrcaAdapter(), clock: deps.clock ?? systemClock, store });
  io.stdout(json ? rosterJsonLine(`roster ${sub}`, result) : result.outcome === 'saved' ? `roster saved: ${result.agents} agents\n` : `roster not saved: ${result.reason}\n`);
  return result.outcome === 'saved' ? 0 : 1;
}

// `group add|list|show|remove`: runs before the safety switch, the store and the lock, because it never sends and never touches a run.
async function mainGroup(rest: string[], values: FlagValues, json: boolean, env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps): Promise<number> {
  const [sub, ...args] = rest;
  if (!isGroupSubcommand(sub)) throw new UsageError(sub === undefined ? 'missing group subcommand' : `unknown group subcommand "${sub}"`);
  validateGroupArgs(sub, args, values);
  checkStates(values);
  const spec: GroupSpec = { ...filterSpecOf(values), state: ((values.state as string[] | undefined) ?? []) as GroupSpec['state'] };
  const result = await runGroup(sub, args[0], spec, { path: resolveGroupsPath(env), port: () => deps.port ?? createOrcaAdapter(), clock: deps.clock ?? systemClock, cwd: deps.cwd ?? process.cwd() });
  io.stdout(json ? groupJsonLine(`group ${sub}`, result) : result.text);
  return 0;
}
