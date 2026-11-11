import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentRecord, fakeClock, FakeOrca, repliesWithToken, seedOpenRun, startsNewTurnAfterContinue, working, type Behavior, type FakeAgent } from './helpers/fake-orca.js';
import { readRoster, rosterNames, scanOf } from './helpers/roster.js';
import { runCli, type RunCliOptions } from './helpers/run-cli.js';

const TOKEN = 'abcd1234';
const newToken = () => TOKEN;
const acks: Behavior = ({ received }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'done', message: `Handled it.\nORCA-ACK ${TOKEN}` });

const withSession = (port: FakeOrca): void => {
  port.scanAt = () => scanOf({ sessionId: 'session-a', paneKey: 'a:1', startTime: 5 });
};
const cli = (argv: string[], agents: FakeAgent[], opts: RunCliOptions = {}) => runCli(argv, agents, { newToken, configure: withSession, ...opts });
const broadcastArgs = ['broadcast', 'hello', '--yes', '--timeout', '10s'];
const agentA: FakeAgent = { paneKey: 'a:1', behavior: acks };
const pausedRun = (extra: Partial<FakeAgent> = {}): FakeAgent => ({ paneKey: 'a:1', behavior: repliesWithToken(), ...extra });

const seedPending = async (store: Parameters<NonNullable<RunCliOptions['seed']>>[0]) => {
  await seedOpenRun(store, [agentRecord('a:1', { pauseBaseline: 'Stopped here.\nORCA-PAUSED abcd1234' })]);
};
const resumeAgent: FakeAgent = { paneKey: 'a:1', behavior: startsNewTurnAfterContinue };

describe('automatic roster saves', () => {
  it('broadcast saves the roster at its start and at its end: two scans, one file with the agent', async () => {
    const { code, port, dir } = await cli(broadcastArgs, [agentA]);
    expect(code).toBe(0);
    expect(port.scanCalls).toBe(2);
    const names = await rosterNames(dir);
    expect(names).toHaveLength(1);
    expect((await readRoster(dir, names[0] as string)).entries.map((e) => e.sessionId)).toEqual(['session-a']);
  });

  it('pause saves the roster, and resume saves it again', async () => {
    const paused = await cli(['pause', '--yes'], [pausedRun()]);
    expect(paused.code).toBe(0);
    expect(paused.port.scanCalls).toBe(2);
    expect(await rosterNames(paused.dir)).toHaveLength(1);

    const resumed = await cli(['resume', '--yes'], [resumeAgent], { seed: (store) => seedPending(store) });
    expect(resumed.code).toBe(0);
    expect(await rosterNames(resumed.dir)).toHaveLength(1);
  });

  it('the roster saves of broadcast, pause and resume store the layout title of the tab', async () => {
    const saved = async (dir: string) => (await readRoster(dir, (await rosterNames(dir))[0] as string)).entries.map((e) => e.title);
    const broadcast = await cli(broadcastArgs, [{ ...agentA, tabTitle: 'Tab One' }]);
    expect(await saved(broadcast.dir)).toEqual(['Tab One']);
    const paused = await cli(['pause', '--yes'], [pausedRun({ tabTitle: 'Tab Two' })]);
    expect(await saved(paused.dir)).toEqual(['Tab Two']);
    const resumed = await cli(['resume', '--yes'], [{ ...resumeAgent, tabTitle: 'Tab Three' }], { seed: (store) => seedPending(store) });
    expect(await saved(resumed.dir)).toEqual(['Tab Three']);
  });

  it('resume --yes takes one snapshot and scans once; a confirmed resume scans twice; a declined one scans once', async () => {
    const yes = await cli(['resume', '--yes'], [resumeAgent], { seed: (store) => seedPending(store) });
    expect(yes.port.scanCalls).toBe(1);
    const confirmed = await cli(['resume'], [resumeAgent], { seed: (store) => seedPending(store), ask: ['y'] });
    expect(confirmed.port.scanCalls).toBe(2);
    const declined = await cli(['resume'], [resumeAgent], { seed: (store) => seedPending(store), ask: ['n'] });
    expect(declined.port.scanCalls).toBe(1);
    expect(await rosterNames(declined.dir)).toHaveLength(1);
  });

  it('the end save uses the newest snapshot: an agent that appears in the last listing is in the file', async () => {
    const late: FakeAgent = { paneKey: 'b:2', behavior: acks, rowAt: (listing) => listing >= 3 };
    const { port, dir } = await cli(broadcastArgs, [agentA, late], {
      configure: (p) => {
        p.scanAt = () => scanOf({ sessionId: 'session-a', paneKey: 'a:1', startTime: 5 }, { sessionId: 'session-b', paneKey: 'b:2', startTime: 6 });
      },
    });
    expect(port.scanCalls).toBe(2);
    const [name] = await rosterNames(dir);
    expect((await readRoster(dir, name as string)).entries.map((e) => e.sessionId).sort()).toEqual(['session-a', 'session-b']);
  });

  it('a filtered pause that selects nobody scans once: the pre-lock listing never saves', async () => {
    const { code, port, out } = await cli(['pause', '--yes', '--role', 'coordinator'], [pausedRun()]);
    expect(code).toBe(0);
    expect(out).toContain('nothing to pause');
    expect(port.listCalls).toBeGreaterThanOrEqual(2);
    expect(port.scanCalls).toBe(1);
  });

  it('a pause whose filter does not resolve fails in the pre-lock check and saves nothing', async () => {
    const { code, port, dir } = await cli(['pause', '--yes', '--repo', 'nobody'], [pausedRun()]);
    expect(code).toBe(2);
    expect(port.scanCalls).toBe(0);
    expect(await rosterNames(dir)).toEqual([]);
  });

  it('a broadcast that ends before its first snapshot saves nothing', async () => {
    const { code, port, dir } = await cli(broadcastArgs, [agentA], { seed: (store) => seedOpenRun(store, [agentRecord('a:1')]) });
    expect(code).toBe(2);
    expect(port.scanCalls).toBe(0);
    expect(await rosterNames(dir)).toEqual([]);
  });

  it('a resume with no open run saves nothing', async () => {
    const { port, dir } = await cli(['resume', '--yes'], [resumeAgent]);
    expect(port.scanCalls).toBe(0);
    expect(await rosterNames(dir)).toEqual([]);
  });

  it('a listing that fails after the start save still gets an end save from the newest snapshot, and the exit code is unchanged', async () => {
    const stuck: FakeAgent = { paneKey: 'a:1', behavior: working };
    const { code, port } = await cli(broadcastArgs, [stuck], {
      configure: (p) => {
        withSession(p);
        p.failListingsFrom = 5;
      },
    });
    expect(code).toBe(2);
    expect(port.scanCalls).toBe(2);
  });

  it('a polling loop never scans: a broadcast that waits through several ticks scans at most twice', async () => {
    const slow: FakeAgent = { paneKey: 'a:1', behavior: ({ listCalls, received }) => (received.length > 0 && listCalls > 8 ? { state: 'done', message: `Done.\nORCA-ACK ${TOKEN}` } : { state: 'working', message: null }) };
    const { port } = await cli(broadcastArgs, [slow], { clock: fakeClock() });
    expect(port.listCalls).toBeGreaterThan(5);
    expect(port.scanCalls).toBeLessThanOrEqual(2);
  });
});

describe('a failed roster save only warns', () => {
  const failures: [string, (port: FakeOrca) => void][] = [
    ['a failed scan', (p) => { p.failScansFrom = 1; }],
    ['an unreadable boot ID', (p) => { withSession(p); p.failBootId = true; }],
  ];

  it.each(failures)('%s: exit code and records are unchanged, the warning goes to stderr', async (_name, configure) => {
    const ok = await cli(broadcastArgs, [agentA]);
    const failed = await cli(broadcastArgs, [agentA], { configure });
    expect(failed.code).toBe(ok.code);
    expect(failed.err).toContain('orca-broadcast: roster not saved: ');
    expect(await rosterNames(failed.dir)).toEqual([]);
  });

  it.each(failures)('%s: under --json the warning is in the warnings field and stderr is empty', async (_name, configure) => {
    const { code, out, err } = await cli([...broadcastArgs, '--json'], [agentA], { configure });
    expect(code).toBe(0);
    expect(err).toBe('');
    const object = JSON.parse(out) as { warnings: string[]; outcome: string };
    expect(object.outcome).toBe('done');
    expect(object.warnings.length).toBeGreaterThanOrEqual(1);
    expect(object.warnings.every((w) => w.startsWith('roster not saved: '))).toBe(true);
  });

  it('an unreadable roster folder warns and the command still succeeds', async () => {
    const seed: RunCliOptions['seed'] = async (_store, dir) => {
      await mkdir(join(dir, 'orca-broadcast'), { recursive: true });
      await writeFile(join(dir, 'orca-broadcast', 'roster'), 'not a folder');
    };
    const { code, err } = await cli(broadcastArgs, [agentA], { seed });
    expect(code).toBe(0);
    expect(err).toContain('roster not saved: ');
  });

  it('an invalid roster file warns, names the file, and the command still succeeds', async () => {
    const seed: RunCliOptions['seed'] = async (_store, dir) => {
      await mkdir(join(dir, 'orca-broadcast', 'roster'), { recursive: true });
      await writeFile(join(dir, 'orca-broadcast', 'roster', 'bad.json'), '{not json');
    };
    const { code, err } = await cli(broadcastArgs, [agentA], { seed });
    expect(code).toBe(0);
    expect(err).toMatch(/roster not saved: .*bad\.json/);
  });
});

describe('a command that has seen its abort signal saves no roster', () => {
  const interrupted = (emitter: EventEmitter) => ({ clock: Object.assign(fakeClock(), { onSleep: () => emitter.emit('SIGTERM') }), signals: emitter });

  it('pause aborted during its wait keeps the start save and makes no end save', async () => {
    const emitter = new EventEmitter();
    const { code, port, dir } = await cli(['pause', '--yes'], [{ paneKey: 'a:1', behavior: working }], interrupted(emitter));
    expect(code).toBe(130);
    expect(port.scanCalls).toBe(1);
    expect(await rosterNames(dir)).toHaveLength(1);
  });

  it('resume aborted during its wait makes no end save', async () => {
    const emitter = new EventEmitter();
    const { code, port } = await cli(['resume'], [resumeAgent], { seed: (store) => seedPending(store), ask: ['y'], ...interrupted(emitter) });
    expect(code === 130 || code === 0).toBe(true);
    expect(port.scanCalls).toBeLessThanOrEqual(2);
  });

  it.each([
    ['broadcast', broadcastArgs],
    ['pause', ['pause', '--yes']],
  ])('%s aborted during its start scan writes no roster', async (_name, argv) => {
    const emitter = new EventEmitter();
    const { code, dir } = await cli(argv, [pausedRun()], {
      signals: emitter,
      configure: (p) => {
        p.scanAt = () => {
          emitter.emit('SIGTERM');
          return scanOf({ sessionId: 'session-a', paneKey: 'a:1' });
        };
      },
    });
    expect(code).toBe(130);
    expect(await rosterNames(dir)).toEqual([]);
  });
});

describe('a declined prompt', () => {
  it('a pause that is declined at the prompt saved the roster at its start', async () => {
    const { code, port, dir } = await cli(['pause'], [pausedRun()], { ask: ['n'] });
    expect(code).toBe(2);
    expect(port.scanCalls).toBe(1);
    expect(await rosterNames(dir)).toHaveLength(1);
  });
});

