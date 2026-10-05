import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withLockAndSignals, type SignalSource } from './guard.js';
import { createOrcaAdapter } from './orca-adapter.js';
import { close } from './close.js';
import { systemClock } from './clock.js';
import { DEFAULT_TIMEOUT_MS, pause, type PauseDeps } from './pause.js';
import { renderCloseTable, renderProgress, renderResumeProgress, renderResumeTable, renderSelfBlock, renderTable } from './render.js';
import { resume } from './resume.js';
import { createRecordStore } from './store.js';
import type { Clock, OrcaPort } from './types.js';

const CLEAR_LINE = '\r\x1b[K';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
}

export interface CliDeps {
  signals?: SignalSource;
  port?: OrcaPort;
  clock?: Clock;
  newToken?: PauseDeps['newToken'];
}

const USAGE = `Usage: orca-pause pause [--timeout <n>s|m|h]
       orca-pause resume
       orca-pause close

Commands:
  pause    Ask every working Claude Code agent to stop at a clean point and
           prove it did. Exit 0 if all confirmed, 1 if any is unconfirmed.
  resume   Tell every paused agent to continue and prove it did. Exit 0 if the
           run closed (or there was nothing to resume), 1 if any is pending.
  close    Abandon the open run without resuming it: pending agents become
           abandoned, nothing is sent. Exit 0 (also when there is nothing to close).

Options:
  --timeout <n>s|m|h   How long pause waits for confirmations (default 10m)
  --help               Show this help
`;

class UsageError extends Error {}

function parseUsage(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: { help: { type: 'boolean' }, timeout: { type: 'string' } }, allowPositionals: true });
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
  return join(base, 'orca-pause');
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps = {}): Promise<number> {
  try {
    const { values, positionals } = parseUsage(argv);
    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    const command = positionals[0];
    if (positionals.length !== 1 || (command !== 'pause' && command !== 'resume' && command !== 'close')) {
      throw new UsageError(positionals.length === 0 ? 'missing command' : `unknown command "${positionals.join(' ')}"`);
    }
    if (command !== 'pause' && values.timeout !== undefined) throw new UsageError('--timeout applies only to pause');
    const timeoutMs = values.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseTimeout(values.timeout);

    const store = createRecordStore(resolveStateDir(env));
    const progressLine = <P>(render: (progress: P) => string) =>
      io.isTTY ? (progress: P) => io.stderr(`${CLEAR_LINE}${render(progress)}`) : undefined;
    const summary = await withLockAndSignals(store, deps.signals ?? process, (signal) => {
      if (command === 'close') return close(store, signal);
      const port = deps.port ?? createOrcaAdapter();
      const clock = deps.clock ?? systemClock;
      return command === 'pause'
        ? pause(timeoutMs, { port, clock, store, newToken: deps.newToken, selfPaneKey: env.ORCA_PANE_KEY, onProgress: progressLine(renderProgress), signal })
        : resume({ port, clock, store, onProgress: progressLine(renderResumeProgress), signal });
    });
    if (io.isTTY && command !== 'close') io.stderr(CLEAR_LINE);

    if (summary.outcome === 'error') {
      io.stderr(`orca-pause: ${summary.error}\n`);
    } else if (summary.outcome === 'nothing-to-do') {
      const selfBlock = summary.self ? renderSelfBlock(summary.self) : '';
      io.stdout(`nothing to ${command}\n${selfBlock}`);
    } else {
      io.stdout(command === 'pause' ? renderTable(summary.rows, summary.self) : command === 'resume' ? renderResumeTable(summary.rows) : renderCloseTable(summary.rows));
    }
    return summary.exitCode;
  } catch (error) {
    io.stderr(`orca-pause: ${(error as Error).message}\n`);
    if (error instanceof UsageError) io.stderr(USAGE);
    return 2;
  }
}
