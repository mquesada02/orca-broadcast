import type { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import { createRecordStore, type RecordStore } from '../../src/store.js';
import { fakeClock, FakeOrca, tempStateDir, type FakeAgent } from './fake-orca.js';

export type Seed = (store: RecordStore, dir: string) => Promise<unknown>;

export interface RunCliOptions {
  isTTY?: boolean;
  seed?: Seed;
  configure?: (port: FakeOrca) => void;
  env?: NodeJS.ProcessEnv;
  signals?: EventEmitter;
  clock?: ReturnType<typeof fakeClock>;
}

/** Runs the CLI shell once with a fake Orca port, a fake clock and a fresh state directory. */
export async function runCli(argv: string[], agents: FakeAgent[] = [], opts: RunCliOptions = {}) {
  const dir = await tempStateDir();
  await opts.seed?.(createRecordStore(join(dir, 'orca-pause')), dir);
  const out: string[] = [];
  const err: string[] = [];
  const port = new FakeOrca(agents);
  opts.configure?.(port);
  const code = await main(argv, { XDG_STATE_HOME: dir, ...opts.env }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: opts.isTTY ?? false }, { port, clock: opts.clock ?? fakeClock(), signals: opts.signals });
  return { code, out: out.join(''), err: err.join(''), port, dir };
}
