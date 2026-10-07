import type { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Interrupted } from '../../src/abort.js';
import { PromptInterrupted } from '../../src/ask.js';
import { main } from '../../src/cli.js';
import { createRecordStore, type RecordStore, type StoreOptions } from '../../src/store.js';
import type { Clock } from '../../src/types.js';
import { fakeClock, FakeOrca, tempStateDir, type FakeAgent } from './fake-orca.js';

export type Seed = (store: RecordStore, dir: string) => Promise<unknown>;

/** Where `runCli` points XDG_CONFIG_HOME for a state folder: next to it, so a test never touches the real ~/.config. */
const configDirOf = (stateDir: string): string => join(dirname(stateDir), 'config');
export const groupsFile = (stateDir: string): string => join(configDirOf(stateDir), 'orca-broadcast', 'groups.json');

/** Writes groups.json (an object is saved as JSON; a string is written as it is, to test a broken file). */
export async function writeGroups(stateDir: string, content: unknown): Promise<void> {
  await mkdir(dirname(groupsFile(stateDir)), { recursive: true });
  await writeFile(groupsFile(stateDir), typeof content === 'string' ? content : JSON.stringify(content));
}

/** A seed that saves these groups. */
export const seedGroups =
  (groups: Record<string, Record<string, string[]>>): Seed =>
  (_store, dir) =>
    writeGroups(dir, { version: 1, groups });

/** One scripted answer: text, a function (so a test can act while the prompt is open), CTRL_C, or 'SIGTERM' (signal while the prompt waits, then hang until aborted). */
export const CTRL_C = Symbol('ctrl-c');
export type Answer = string | ((signal?: AbortSignal) => string | Promise<string>) | typeof CTRL_C;

export interface RunCliOptions {
  /** Makes the run interactive: the shell can ask, and gets these answers in order (an empty answer when they run out). */
  ask?: Answer[];
  isTTY?: boolean;
  seed?: Seed;
  configure?: (port: FakeOrca) => void;
  env?: NodeJS.ProcessEnv;
  signals?: EventEmitter;
  clock?: Clock;
  newToken?: () => string;
  cwd?: string;
  /** The process-kill fake. A test that does not give one fails if the CLI tries to signal a process: it must never reach a real one. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** The pid, liveness and start-time fakes of the CLI's own store. */
  storeOptions?: StoreOptions;
}

/** The default process-kill fake: a test that does not give one fails if the CLI tries to signal a process, so it never reaches a real one. */
export const noKill = (pid: number): void => {
  throw new Error(`test gave no kill, but the CLI tried to signal ${pid}`);
};

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
        return Promise.resolve(typeof answer === 'function' ? answer(signal) : answer);
      }
    : undefined;
  const code = await main(argv, { XDG_STATE_HOME: dir, XDG_CONFIG_HOME: configDirOf(dir), ...opts.env }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: opts.isTTY ?? false, ask }, { port, clock: opts.clock ?? fakeClock(), signals: opts.signals, newToken: opts.newToken, kill: opts.kill ?? noKill, storeOptions: opts.storeOptions, cwd: opts.cwd });
  return { code, out: out.join(''), err: err.join(''), port, questions, dir };
}
