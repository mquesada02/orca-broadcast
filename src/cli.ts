import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Interrupted, throwIfAborted } from './abort.js';
import { PromptInterrupted } from './ask.js';
import { broadcast, normaliseText } from './broadcast.js';
import { withLockAndSignals, type SignalSource } from './guard.js';
import { createOrcaAdapter } from './orca-adapter.js';
import { close } from './close.js';
import { systemClock } from './clock.js';
import { DEFAULT_TIMEOUT_MS, pause, type PauseDeps } from './pause.js';
import { describeFilters, hasFilters } from './filters.js';
import { isCommand, PARSE_OPTIONS, UsageError, validateFlags, type Command, type FlagValues } from './flags.js';
import { renderBroadcastProgress, renderBroadcastSelfBlock, renderBroadcastTable, renderCloseTable, renderProgress, renderResumeProgress, renderResumeTable, renderSelfBlock, renderTable, renderUnknownRuns } from './render.js';
import { isPreset, PRESET_NAMES } from './reasons.js';
import { resume } from './resume.js';
import { createRecordStore } from './store.js';
import type { Clock, Confirm, FilterSpec, OrcaPort, Role, RunSummary } from './types.js';

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
}

const USAGE = `Usage: orca-broadcast broadcast "<text>" | --file <path> [--timeout <n>s|m|h] [--yes]
       orca-broadcast pause [filters] [--timeout <n>s|m|h] [--reason <name>] [--yes]
       orca-broadcast resume [filters] [--yes]
       orca-broadcast close [filters]

Commands:
  broadcast  Send one line of text to every working or done Claude Code agent and prove each
           one handled it: its new last reply must end with ORCA-ACK <token>. Exit 0 if all
           acked, 1 if any did not, 2 on a refusal. The text is one line of at most 1000 characters.
  pause    Ask every working Claude Code agent to stop at a clean point and
           prove it did. Exit 0 if all confirmed, 1 if any is unconfirmed.
  resume   Tell every paused agent to continue and prove it did. Exit 0 if the
           run closed (or there was nothing to resume), 1 if any is pending.
  close    Abandon the open run without resuming it: pending agents become
           abandoned, nothing is sent. Exit 0 (also when there is nothing to close).

Filters (pause, resume and close; repeat a flag for several values; kinds are ANDed, values of one kind ORed):
  --repo <id|path|name>          Agents in that repo
  --worktree <path|id|name>      Agents in that worktree (a name is looked up in the --repo values)
  --role <role>                  coordinator, worker or session
  --run <id>                     Agents of that orchestration run
  Without filters a command acts on every agent. resume and close act only on recorded agents.

Options:
  --timeout <n>s|m|h   How long pause waits for confirmations, or broadcast waits for acks (default 10m)
  --reason <name>      Why you pause: network, away, end-of-day or limit. Changes only the first sentence
                       of the pause and continue messages (default: neutral). pause only
  --file <path>        Read the broadcast text from a file instead of the command line. broadcast only
  --yes                Skip the confirmation before broadcast, pause or resume sends. Without a terminal
                       (a script, an agent's shell) they refuse to send unless you pass it
  --json               With a command, print one JSON object on stdout and nothing on stderr.
                       It never asks for confirmation, so broadcast, pause and resume need --yes
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

// What `broadcast` prints, and what `close` prints when it closed a broadcast.
function renderBroadcastOutput(command: Command | null, summary: RunSummary): string {
  const self = summary.broadcastSelf ? `${renderBroadcastSelfBlock(summary.broadcastSelf)}\n` : '';
  if (summary.outcome === 'nothing-to-do') return `nothing to ${command === 'broadcast' ? 'broadcast' : 'close'}\n${self}`;
  const targets = summary.record?.targets ?? [];
  const heading = command === 'close' ? `closed broadcast ${summary.record?.id}\n` : '';
  return `${heading}${renderBroadcastTable(targets)}${self}`;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps = {}): Promise<number> {
  // Read from the raw argv so that an argument parse failure still gets a JSON answer.
  const json = argv.includes('--json');
  let command: Command | null = null;
  try {
    const { values, positionals } = parseUsage(argv);
    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    const [name, ...rest] = positionals;
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
    const filterSpec: FilterSpec = { repo: (values.repo as string[] | undefined) ?? [], worktree: (values.worktree as string[] | undefined) ?? [], role: (values.role as Role[] | undefined) ?? [], run: (values.run as string[] | undefined) ?? [] };
    const filters = hasFilters(filterSpec) ? filterSpec : undefined;
    // The safety switch: nothing is sent without a yes from the user, or --yes. This runs before anything is read, locked or listed.
    const needsConfirm = command !== 'close' && !values.yes;
    if (needsConfirm && (io.ask === undefined || json)) throw new Error('refusing to send without an interactive terminal: pass --yes to confirm');
    const confirm = needsConfirm && io.ask ? confirmOnTerminal(io, io.ask) : undefined;
    // No text and no --file is not an error here: the records decide whether there is a broadcast to refuse or to continue.
    const rawText = values.file === undefined ? rest[0] : await readTextFile(values.file as string);
    const text = rawText === undefined ? undefined : normaliseText(rawText);

    const store = createRecordStore(resolveStateDir(env));
    const progressLine = <P>(render: (progress: P) => string) =>
      io.isTTY && !json ? (progress: P) => io.stderr(`${CLEAR_LINE}${render(progress)}`) : undefined;
    const summary = await withLockAndSignals(store, deps.signals ?? process, (signal) => {
      const clock = deps.clock ?? systemClock;
      const { cwd } = deps;
      // A plain close never uses the port; only a filtered one needs live listings.
      if (command === 'close') return close(store, signal, filters ? { filters, port: deps.port ?? createOrcaAdapter(), clock, cwd } : undefined);
      const port = deps.port ?? createOrcaAdapter();
      if (command === 'broadcast') return broadcast(text, timeoutMs, { port, clock, store, newToken: deps.newToken, selfPaneKey: env.ORCA_PANE_KEY, onProgress: progressLine(renderBroadcastProgress), confirm, signal });
      return command === 'pause'
        ? pause(timeoutMs, { port, clock, store, newToken: deps.newToken, selfPaneKey: env.ORCA_PANE_KEY, reason: reason as PauseDeps['reason'], filters, cwd, onProgress: progressLine(renderProgress), confirm, signal })
        : resume({ port, clock, store, filters, cwd, onProgress: progressLine(renderResumeProgress), confirm, signal });
    });
    if (json) {
      io.stdout(jsonLine(command, summary));
      return summary.exitCode;
    }
    if (io.isTTY && command !== 'close') io.stderr(CLEAR_LINE);

    // The agents of this output: the rows, and self where the output has a self block.
    const shown = summary.self ? [...summary.rows, summary.self] : summary.rows;
    if (summary.warning) io.stderr(`orca-broadcast: ${summary.warning}\n`);
    if (summary.outcome === 'error') {
      io.stderr(`orca-broadcast: ${summary.error}\n`);
    } else if (command === 'broadcast' || summary.record) {
      io.stdout(renderBroadcastOutput(command, summary));
    } else if (summary.outcome === 'nothing-to-do') {
      const selfBlock = summary.self ? `${renderSelfBlock(summary.self)}\n` : '';
      const filterLine = filters ? `filters: ${describeFilters(filters)}\n` : '';
      io.stdout(`nothing to ${command}\n${filterLine}${selfBlock}${renderUnknownRuns(shown)}`);
    } else {
      const table = command === 'pause' ? renderTable(summary.rows, summary.self) : command === 'resume' ? renderResumeTable(summary.rows) : renderCloseTable(summary.rows);
      io.stdout(`${table}${renderUnknownRuns(shown)}`);
    }
    return summary.exitCode;
  } catch (error) {
    if (json) {
      io.stdout(jsonLine(command, { outcome: 'error', exitCode: 2, run: null, error: (error as Error).message }));
      return 2;
    }
    io.stderr(`orca-broadcast: ${(error as Error).message}\n`);
    if (error instanceof UsageError) io.stderr(USAGE);
    return 2;
  }
}
