import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { createRecordStore } from '../src/store.js';
import { agentRecord, fakeClock, FakeOrca, repliesWithToken, seedOpenRun, startsNewTurnAfterContinue, tempStateDir, working, type FakeAgent } from './helpers/fake-orca.js';
import type { AgentRecord } from '../src/types.js';

type Seed = (store: ReturnType<typeof createRecordStore>, dir: string) => Promise<unknown>;

async function invoke(argv: string[], agents: FakeAgent[] = [], opts: { isTTY?: boolean; seed?: Seed; configure?: (port: FakeOrca) => void; env?: NodeJS.ProcessEnv; signals?: EventEmitter; clock?: ReturnType<typeof fakeClock> } = {}) {
  const dir = await tempStateDir();
  await opts.seed?.(createRecordStore(join(dir, 'orca-pause')), dir);
  const out: string[] = [];
  const err: string[] = [];
  const port = new FakeOrca(agents);
  opts.configure?.(port);
  const code = await main(argv, { XDG_STATE_HOME: dir, ...opts.env }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: opts.isTTY ?? false }, { port, clock: opts.clock ?? fakeClock(), signals: opts.signals });
  return { code, out: out.join(''), err: err.join(''), port, dir };
}

/** stdout must be one single-line JSON object; returns it parsed. */
function onlyObject(out: string): Record<string, unknown> {
  expect(out.endsWith('\n')).toBe(true);
  expect(out.trimEnd()).not.toContain('\n');
  const parsed = JSON.parse(out);
  expect(Object.keys(parsed).sort()).toEqual(['command', 'error', 'exitCode', 'outcome', 'run']);
  return parsed;
}

const seedAgents = (agents: AgentRecord[]): Seed => (store) => seedOpenRun(store, agents);

describe('--json pause', () => {
  it('exit 0: done with the run record, lastHandle and confirmedAt included, nothing on stderr', async () => {
    const { code, out, err } = await invoke(['pause', '--json'], [{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    const object = onlyObject(out);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(object).toMatchObject({ command: 'pause', outcome: 'done', exitCode: 0, error: null });
    const run = object.run as { agents: AgentRecord[]; status: string };
    expect(run.status).toBe('open');
    expect(run.agents[0]).toMatchObject({ paneKey: 'a:1', pauseStatus: 'confirmed', lastHandle: 'term_a:1' });
    expect(run.agents[0]?.confirmedAt).toEqual(expect.any(String));
  });

  it('exit 1: unconfirmed agents still give outcome done and an error of null', async () => {
    const { code, out } = await invoke(['pause', '--json', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: working }]);
    expect(code).toBe(1);
    expect(onlyObject(out)).toMatchObject({ command: 'pause', outcome: 'done', exitCode: 1, error: null, run: { agents: [{ pauseStatus: 'unconfirmed', pauseReason: 'still-working' }] } });
  });

  it('exit 2: an Orca failure gives outcome error with the message and no run', async () => {
    const { code, out, err } = await invoke(['pause', '--json'], [{ paneKey: 'a:1', behavior: working }], { configure: (p) => (p.listError = new Error('orca-ide worktree ps failed: boom')) });
    expect(code).toBe(2);
    expect(err).toBe('');
    const object = onlyObject(out);
    expect(object).toMatchObject({ command: 'pause', outcome: 'error', exitCode: 2, run: null });
    expect(object.error).toContain('boom');
  });

  it('nothing-to-do: run and error are null, and the self line stays out of the JSON', async () => {
    const { code, out } = await invoke(['pause', '--json'], [{ paneKey: 'a:1', behavior: working }], { env: { ORCA_PANE_KEY: 'a:1' } });
    expect(code).toBe(0);
    expect(onlyObject(out)).toEqual({ command: 'pause', outcome: 'nothing-to-do', exitCode: 0, run: null, error: null });
  });

  it('exit 130: an interrupt mid-wait gives outcome error with the saved run', async () => {
    const signals = new EventEmitter();
    const clock = Object.assign(fakeClock(), { onSleep: () => signals.emit('SIGTERM') });
    const { code, out, err } = await invoke(['pause', '--json'], [{ paneKey: 'a:1', behavior: working }], { signals, clock });
    expect(code).toBe(130);
    expect(err).toBe('');
    const object = onlyObject(out);
    expect(object).toMatchObject({ command: 'pause', outcome: 'error', exitCode: 130 });
    expect(object.error).toContain('interrupted by SIGTERM');
    expect((object.run as { agents: unknown[] }).agents).toHaveLength(1);
  });

  it('prints no progress line and no line clear on a terminal', async () => {
    const { err, out } = await invoke(['pause', '--json', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: working }], { isTTY: true });
    expect(err).toBe('');
    onlyObject(out);
  });
});

describe('--json resume', () => {
  const pending = (extra: Partial<AgentRecord> = {}) => agentRecord('a:1', { pauseBaseline: 'Stopped here.\nORCA-PAUSED abcd1234', ...extra });

  it('exit 0: done with the closed run', async () => {
    const { code, out, err } = await invoke(['resume', '--json'], [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }], { seed: seedAgents([pending()]) });
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(onlyObject(out)).toMatchObject({ command: 'resume', outcome: 'done', exitCode: 0, error: null, run: { status: 'closed', agents: [{ resumeStatus: 'resumed' }] } });
  });

  it('exit 1: a pending agent still gives outcome done and an error of null', async () => {
    const { code, out } = await invoke(['resume', '--json'], [{ paneKey: 'a:1', behavior: () => ({ state: 'waiting', message: 'x' }) }], { seed: seedAgents([pending()]) });
    expect(code).toBe(1);
    expect(onlyObject(out)).toMatchObject({ command: 'resume', outcome: 'done', exitCode: 1, error: null, run: { status: 'open', agents: [{ resumeStatus: 'pending', resumeReason: 'waiting-permission' }] } });
  });

  it('exit 2: an Orca failure after the run is loaded gives outcome error with the run', async () => {
    const { code, out, err } = await invoke(['resume', '--json'], [{ paneKey: 'a:1', behavior: working }], {
      seed: seedAgents([pending()]),
      configure: (p) => (p.listError = new Error('orca-ide worktree ps failed: boom')),
    });
    expect(code).toBe(2);
    expect(err).toBe('');
    const object = onlyObject(out);
    expect(object).toMatchObject({ command: 'resume', outcome: 'error', exitCode: 2 });
    expect(object.error).toContain('boom');
    expect(object.run).not.toBeNull();
  });

  it('nothing-to-do: no open run gives run and error of null', async () => {
    const { code, out } = await invoke(['resume', '--json']);
    expect(code).toBe(0);
    expect(onlyObject(out)).toEqual({ command: 'resume', outcome: 'nothing-to-do', exitCode: 0, run: null, error: null });
  });

  it('prints no progress line on a terminal', async () => {
    const { err } = await invoke(['resume', '--json'], [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }], { isTTY: true, seed: seedAgents([pending()]) });
    expect(err).toBe('');
  });
});

describe('--json close', () => {
  it('exit 0: done with the closed run and its abandoned agents', async () => {
    const { code, out, err } = await invoke(['close', '--json'], [], { seed: seedAgents([agentRecord('a:1')]), isTTY: true });
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(onlyObject(out)).toMatchObject({ command: 'close', outcome: 'done', exitCode: 0, error: null, run: { status: 'closed', agents: [{ resumeStatus: 'abandoned' }] } });
  });

  it('exit 2: an unreadable record gives outcome error and no run', async () => {
    const { code, out, err } = await invoke(['close', '--json'], [], {
      seed: async (store) => {
        await mkdir(store.dir, { recursive: true });
        await writeFile(join(store.dir, 'bad.json'), '{nope');
      },
    });
    expect(code).toBe(2);
    expect(err).toBe('');
    const object = onlyObject(out);
    expect(object).toMatchObject({ command: 'close', outcome: 'error', exitCode: 2, run: null });
    expect(object.error).toContain('unreadable record');
  });

  it('nothing-to-do: no open run gives run and error of null', async () => {
    const { code, out } = await invoke(['close', '--json']);
    expect(code).toBe(0);
    expect(onlyObject(out)).toEqual({ command: 'close', outcome: 'nothing-to-do', exitCode: 0, run: null, error: null });
  });
});

describe('--json errors outside the commands', () => {
  it.each([
    [['pause', '--bogus', '--json'], null, 'bogus'],
    [['pause', '--timeout', '--json'], null, 'timeout'],
    [['--json'], null, 'missing command'],
    [['bogus', '--json'], null, 'unknown command'],
    [['pause', 'extra', '--json'], null, 'unknown command'],
    [['close', '--timeout', '5s', '--json'], 'close', 'only to pause'],
    [['pause', '--timeout', '0s', '--json'], 'pause', 'invalid --timeout'],
  ])('%j gives one error object, command %j, exit 2, empty stderr, Orca untouched', async (argv, command, message) => {
    const { code, out, err, port } = await invoke(argv as string[], [{ paneKey: 'a:1', behavior: working }], { isTTY: true });
    expect(code).toBe(2);
    expect(err).toBe('');
    const object = onlyObject(out);
    expect(object).toMatchObject({ command, outcome: 'error', exitCode: 2, run: null });
    expect(object.error).toContain(message);
    expect(port.listCalls).toBe(0);
  });

  it('a held lock gives the error object with the command kept', async () => {
    const { code, out, err } = await invoke(['resume', '--json'], [], {
      seed: async (_store, dir) => {
        await mkdir(join(dir, 'orca-pause'), { recursive: true });
        await writeFile(join(dir, 'orca-pause', 'lock'), `${process.pid}\n`);
      },
    });
    expect(code).toBe(2);
    expect(err).toBe('');
    const object = onlyObject(out);
    expect(object).toMatchObject({ command: 'resume', outcome: 'error', exitCode: 2, run: null });
    expect(object.error).toContain('another orca-pause is running');
  });

  it('--help wins over --json when parsing succeeds, and the JSON error wins when it fails', async () => {
    const help = await invoke(['--help', '--json']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: orca-pause pause');
    expect(help.out).toContain('--json');
    const broken = await invoke(['--bogus', '--help', '--json']);
    expect(broken.code).toBe(2);
    expect(onlyObject(broken.out)).toMatchObject({ command: null, outcome: 'error' });
  });
});

describe('final table', () => {
  it('pause: lists unconfirmed first, then self, then confirmed, with one hint on the problem group', async () => {
    const { out } = await invoke(['pause', '--timeout', '10s'], [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a', behavior: repliesWithToken() },
      { paneKey: 'b:2', repo: 'beta', worktree: 'wt-b', behavior: working },
      { paneKey: 's:9', repo: 'sigma', worktree: 'wt-s', behavior: working },
    ], { env: { ORCA_PANE_KEY: 's:9' } });
    const order = ['\nunconfirmed (1)', '\nself (not paused)', '\nconfirmed (1)'].map((heading) => `\n${out}`.indexOf(heading));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(out.match(/check these agents before you leave/g)).toHaveLength(1);
  });

  it('resume: lists pending, gone, resumed in order with one hint each for pending and gone', async () => {
    const { out } = await invoke(['resume'], [
      { paneKey: 'a:1', behavior: startsNewTurnAfterContinue },
      { paneKey: 'b:2', behavior: () => ({ state: 'done', message: 'x' }), agentIdentity: 'zsh' },
      { paneKey: 'c:3', behavior: () => ({ state: 'waiting', message: 'x' }) },
    ], { seed: seedAgents([agentRecord('a:1'), agentRecord('b:2'), agentRecord('c:3')]) });
    const order = ['\npending (1)', '\ngone (1)', '\nresumed (1)'].map((heading) => `\n${out}`.indexOf(heading));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(out.match(/answer the permission prompt/g)).toHaveLength(1);
    expect(out.match(/restart these agents yourself/g)).toHaveLength(1);
  });

  it('close: lists the abandoned group once with its hint', async () => {
    const { out } = await invoke(['close'], [], { seed: seedAgents([agentRecord('a:1'), agentRecord('b:2')]) });
    expect(out.match(/abandoned \(2\) - still paused — continue it by hand/g)).toHaveLength(1);
  });

  it('never shows lastHandle or confirmedAt in the table', async () => {
    const { out } = await invoke(['pause'], [{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    expect(out).not.toContain('term_a:1');
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(out).not.toContain('confirmedAt');
  });
});
