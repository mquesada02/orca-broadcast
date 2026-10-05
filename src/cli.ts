import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createOrcaAdapter } from './orca-adapter.js';
import { systemClock } from './clock.js';
import { DEFAULT_TIMEOUT_MS, pause } from './pause.js';
import { renderProgress, renderTable } from './render.js';
import { createRecordStore } from './store.js';
import type { Clock, OrcaPort } from './types.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
}

export interface CliDeps {
  port?: OrcaPort;
  clock?: Clock;
  newToken?: () => string;
}

const USAGE = `Usage: orca-pause pause [--timeout <n>s|m|h]

Commands:
  pause    Ask every working Claude Code agent to stop at a clean point and
           prove it did. Exit 0 if all confirmed, 1 if any is unconfirmed.

Options:
  --timeout <n>s|m|h   How long to wait for confirmations (default 10m)
  --help               Show this help
`;

class UsageError extends Error {}

export function parseTimeout(value: string): number {
  const match = /^(\d+)([smh])$/.exec(value);
  const amount = match ? Number(match[1]) : 0;
  if (!match || amount <= 0) throw new UsageError(`invalid --timeout "${value}": use a positive whole number plus s, m or h, such as 90s`);
  return amount * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'];
}

export function resolveStateDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const base = env.XDG_STATE_HOME ? env.XDG_STATE_HOME : join(home, '.local', 'state');
  return join(base, 'orca-pause');
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps = {}): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { help: { type: 'boolean' }, timeout: { type: 'string' } },
      allowPositionals: true,
    });
    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    if (positionals.length !== 1 || positionals[0] !== 'pause') {
      throw new UsageError(positionals.length === 0 ? 'missing command' : `unknown command "${positionals.join(' ')}"`);
    }
    const timeoutMs = values.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseTimeout(values.timeout);

    const summary = await pause(timeoutMs, {
      port: deps.port ?? createOrcaAdapter(),
      clock: deps.clock ?? systemClock,
      store: createRecordStore(resolveStateDir(env)),
      newToken: deps.newToken,
      onProgress: io.isTTY ? (progress) => io.stderr(`\r\x1b[K${renderProgress(progress)}`) : undefined,
    });
    if (io.isTTY) io.stderr('\r\x1b[K');

    if (summary.outcome === 'error') {
      io.stderr(`orca-pause: ${summary.error}\n`);
    } else if (summary.outcome === 'nothing-to-do') {
      io.stdout('nothing to pause\n');
    } else {
      io.stdout(renderTable(summary.rows));
    }
    return summary.exitCode;
  } catch (error) {
    io.stderr(`orca-pause: ${(error as Error).message}\n`);
    if (error instanceof UsageError || (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) io.stderr(USAGE);
    return 2;
  }
}
