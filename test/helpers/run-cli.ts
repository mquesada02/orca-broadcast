import type { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Interrupted } from '../../src/abort.js';
import { PromptInterrupted } from '../../src/ask.js';
import { main } from '../../src/cli.js';
import { createRecordStore, type RecordStore } from '../../src/store.js';
import { fakeClock, FakeOrca, tempStateDir, type FakeAgent } from './fake-orca.js';

export type Seed = (store: RecordStore, dir: string) => Promise<unknown>;

/** One scripted answer: text, a function (so a test can act while the prompt is open), CTRL_C, or 'SIGTERM' (signal while the prompt waits, then hang until aborted). */
export const CTRL_C = Symbol('ctrl-c');
export type Answer = string | (() => string) | typeof CTRL_C;

export interface RunCliOptions {
  /** Makes the run interactive: the shell can ask, and gets these answers in order (an empty answer when they run out). */
  ask?: Answer[];
  isTTY?: boolean;
  seed?: Seed;
  configure?: (port: FakeOrca) => void;
  env?: NodeJS.ProcessEnv;
  signals?: EventEmitter;
  clock?: ReturnType<typeof fakeClock>;
  newToken?: () => string;
  cwd?: string;
}

/** Runs the CLI shell once with a fake Orca port, a fake clock and a fresh state directory. */
export async function runCli(argv: string[], agents: FakeAgent[] = [], opts: RunCliOptions = {}) {
  const dir = await tempStateDir();
  await opts.seed?.(createRecordStore(join(dir, 'orca-broadcast')), dir);
  const out: string[] = [];
  const err: string[] = [];
  const port = new FakeOrca(agents);
  opts.configure?.(port);
  const questions: string[] = [];
  const script = [...(opts.ask ?? [])];
  const ask = opts.ask
    ? (question: string, signal?: AbortSignal): Promise<string> => {
        questions.push(question);
        const answer = script.shift() ?? '';
        if (answer === CTRL_C) return Promise.reject(new PromptInterrupted());
        if (answer === 'SIGTERM') {
          opts.signals?.emit('SIGTERM');
          return new Promise<string>((_, reject) => {
            if (signal?.aborted) return reject(new Interrupted(signal));
            signal?.addEventListener('abort', () => reject(new Interrupted(signal)), { once: true });
          });
        }
        return Promise.resolve(typeof answer === 'function' ? answer() : answer);
      }
    : undefined;
  const code = await main(argv, { XDG_STATE_HOME: dir, ...opts.env }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: opts.isTTY ?? false, ask }, { port, clock: opts.clock ?? fakeClock(), signals: opts.signals, newToken: opts.newToken, cwd: opts.cwd });
  return { code, out: out.join(''), err: err.join(''), port, questions, dir };
}
