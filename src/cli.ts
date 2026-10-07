import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
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
import { checkStates, isCommand, PARSE_OPTIONS, UsageError, validateFlags, validateGroupArgs, type Command, type FlagValues } from './flags.js';
import { renderBroadcastProgress, renderBroadcastSelfBlock, renderBroadcastTable, renderCloseTable, renderProgress, renderResumeProgress, renderResumeTable, renderSelfBlock, renderTable, renderUnknownRuns } from './render.js';
import { isPreset, PRESET_NAMES } from './reasons.js';
import { resume } from './resume.js';
import { createRecordStore, type StoreOptions } from './store.js';
import type { AgentState, Clock, Confirm, FilterSpec, GroupFilter, OrcaPort, Role, RunSummary } from './types.js';

const CLEAR_LINE = '\r\x1b[K';

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

const USAGE = `Usage: orca-broadcast broadcast ["<text>" | --file <path>] [filters] [--timeout <n>s|m|h] [--yes]
       orca-broadcast pause [filters] [--timeout <n>s|m|h] [--reason <name>] [--yes]
       orca-broadcast resume [filters] [--yes]
       orca-broadcast close [filters]
       orca-broadcast group add <name> [filters] [--state working|done] | list | show <name> | remove <name>

Commands:
  broadcast  Send one line of text to every working or done Claude Code agent and prove each
           one handled it: its new last reply must end with ORCA-ACK <token>. Exit 0 if all
           acked, 1 if any did not, 2 on a refusal. The text is one line of at most 1000 characters.
           With no text, or the same text, it continues the open broadcast: same token, a fresh
           --timeout, and it sends again only to agents that never got the message.
  pause    Ask every working Claude Code agent to stop at a clean point and
           prove it did. Exit 0 if all confirmed, 1 if any is unconfirmed.
  resume   Tell every paused agent to continue and prove it did. Exit 0 if the
           run closed (or there was nothing to resume), 1 if any is pending.
  close    Abandon the open run without resuming it: pending agents become
           abandoned, nothing is sent. Exit 0 (also when there is nothing to close).
  group    Save, list, show and remove named filters. add checks that every value resolves now;
           show lists the agents the group matches now. They only read Orca and send nothing.

Filters (broadcast, pause, resume and close; repeat a flag for several values; kinds are ANDed, values of one kind ORed):
  --repo <id|path|name>          Agents in that repo
  --worktree <path|id|name>      Agents in that worktree (a name is looked up in the --repo values)
  --role <role>                  coordinator, worker or session
  --run <id>                     Agents of that orchestration run
  --state <working|done>         Agents in that state (broadcast only)
  --group <name>                 A saved group; one per command. Other filters narrow it. Its state
                                 kind is skipped on pause, resume and close (one line on stderr); a
                                 state-only group is refused there
  Without filters a command acts on every agent. resume, close and a broadcast re-run act only on recorded agents.

Options:
  --timeout <n>s|m|h   How long pause waits for confirmations, or broadcast waits for acks (default 10m)
  --reason <name>      Why you pause: network, away, end-of-day or limit. Changes only the first sentence
                       of the pause and continue messages (default: neutral). pause only
  --file <path>        Read the broadcast text from a file instead of the command line. broadcast only
  --yes                Skip the confirmation before broadcast, pause or resume sends. Without a terminal
                       (a script, an agent's shell) they refuse to send unless you pass it
  --json               With a command, print one JSON object on stdout and nothing on stderr (except
                       the one line about a skipped group state kind). It never asks for confirmation,
                       so broadcast, pause and resume need --yes
  --help               Show this help
`;

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

function jsonLine(command: Command | null, summary: Pick<RunSummary, 'outcome' | 'exitCode' | 'run' | 'error' | 'record'>): string {
  const { outcome, exitCode, run, error, record } = summary;
  return `${JSON.stringify({ command, outcome, exitCode, run, record: record ?? null, error })}\n`;
}

// Lists the targets on stderr and asks once. Ctrl-C at the prompt counts as an interrupt, like SIGTERM.
function confirmOnTerminal(io: CliIo, ask: NonNullable<CliIo['ask']>): Confirm {
  return async (targets, signal, details) => {
    if (io.isTTY) io.stderr(CLEAR_LINE);
    io.stderr(targets.map((t) => `  ${t.repo}/${t.worktree} (${t.role})\n`).join(''));
    if (details) io.stderr(`\nMessage:\n  ${details.message}\n${details.self ? `\nNot sent to this session: ${details.self.repo}/${details.self.worktree} (${details.self.role})\n` : ''}\n`);
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
  try {
    const { values, positionals } = parseUsage(argv);
    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    const [name, ...rest] = positionals;
    group = groupLabel(positionals);
    if (name === 'group') return await mainGroup(rest, values as FlagValues, json, env, io, deps);
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
    const groupFilter = await loadGroupFilter(values.group as string[] | undefined, command, env, io);
    const filtered = isFiltered(filterSpec, groupFilter);
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
    const scope = { port, clock, filters, group: groupFilter, cwd };
    const guardOptions: GuardOptions =
      command === 'pause' && port
        ? {
            prelock: (signal) => prelockPause({ ...scope, port, signal }),
            handOver: { clock, kill: deps.kill ?? process.kill.bind(process), precheck: (signal) => precheckPause({ ...scope, port, selfPaneKey: env.ORCA_PANE_KEY, signal }) },
          }
        : {};
    const summary = await withLockAndSignals(store, deps.signals ?? process, (signal) => {
      if (!port || command === 'close') return close(store, signal, port && filtered ? { filters: filterSpec, group: groupFilter, port, clock, cwd } : undefined);
      if (command === 'broadcast') return broadcast(text, timeoutMs, { port, clock, store, newToken: deps.newToken, selfPaneKey: env.ORCA_PANE_KEY, onProgress: progressLine(renderBroadcastProgress), confirm, signal, filters, group: groupFilter, cwd });
      return command === 'pause'
        ? pause(timeoutMs, { port, clock, store, newToken: deps.newToken, selfPaneKey: env.ORCA_PANE_KEY, reason: reason as PauseDeps['reason'], filters, group: groupFilter, cwd, onProgress: progressLine(renderProgress), confirm, signal })
        : resume({ port, clock, store, filters, group: groupFilter, cwd, onProgress: progressLine(renderResumeProgress), confirm, signal });
    }, guardOptions);
    if (json) {
      io.stdout(jsonLine(command, summary));
      return summary.exitCode;
    }
    if (io.isTTY && command !== 'close') io.stderr(CLEAR_LINE);

    const filterLine = filtered ? `filters: ${[groupFilter && `--group ${groupFilter.name}`, filters && describeFilters(filters)].filter(Boolean).join(' ')}\n` : '';
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
      io.stdout(group ? groupJsonLine(group, null, (error as Error).message) : jsonLine(command, { outcome: 'error', exitCode: 2, run: null, error: (error as Error).message }));
      return 2;
    }
    io.stderr(`orca-broadcast: ${(error as Error).message}\n`);
    if (error instanceof UsageError) io.stderr(USAGE);
    return 2;
  }
}

// Loads the group a command names. For `broadcast` every kind applies. Elsewhere the `state` kind is skipped with one stderr line, in text and in --json mode, and a state-only group is refused.
async function loadGroupFilter(names: string[] | undefined, command: Command, env: NodeJS.ProcessEnv, io: CliIo): Promise<GroupFilter | undefined> {
  const name = names?.[0];
  if (name === undefined) return undefined;
  const spec = lookupGroup(await loadGroups(resolveGroupsPath(env)), name);
  if (command === 'broadcast') return { name, spec };
  const filter = toGroupFilter(name, spec);
  if (!hasFilters(filter.spec)) throw new Error(`Group ${name} only filters by state, which ${command} does not use.`);
  if (spec.state.length > 0) io.stderr(`orca-broadcast: group ${name}: state filter skipped (${command} does not use it)\n`);
  return filter;
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
