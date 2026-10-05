import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { main, parseTimeout, resolveStateDir } from '../src/cli.js';
import { createRecordStore } from '../src/store.js';
import type { AgentRecord } from '../src/types.js';
import { type FakeAgent, fakeClock, FakeOrca, pausedDone, repliesWithToken, startsNewTurnAfterContinue, tempStateDir, working } from './helpers/fake-orca.js';

async function run(
  argv: string[],
  agents: FakeAgent[] = [],
  isTTY = false,
  configure: (port: FakeOrca) => void = () => {},
  seed: (store: ReturnType<typeof createRecordStore>) => Promise<void> = async () => {},
) {
  const dir = await tempStateDir();
  await seed(createRecordStore(`${dir}/orca-pause`));
  const out: string[] = [];
  const err: string[] = [];
  const port = new FakeOrca(agents);
  configure(port);
  const clock = fakeClock();
  const code = await main(argv, { XDG_STATE_HOME: dir }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY }, { port, clock });
  return { code, out: out.join(''), err: err.join(''), dir, port, clock };
}

describe('orca-pause --help and usage', () => {
  it('prints usage and exits 0 for --help', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('Usage: orca-pause pause');
    expect(out).toContain('--timeout');
  });

  it.each([
    [[], 'missing command'],
    [['bogus'], 'unknown command'],
    [['resume', '--timeout', '5s'], 'only to pause'],
    [['close', '--timeout', '5s'], 'only to pause'],
    [['close', 'extra'], 'unknown command'],
    [['close', '--bogus'], 'bogus'],
    [['resume', 'extra'], 'unknown command'],
    [['pause', 'extra'], 'unknown command'],
    [['pause', '--bogus'], 'bogus'],
    [['pause', '--timeout', '0s'], 'invalid --timeout'],
    [['pause', '--timeout', '10'], 'invalid --timeout'],
    [['pause', '--timeout', '1.5m'], 'invalid --timeout'],
    [['pause', '--timeout', '-5s'], 'timeout'],
  ])('exits 2 for %j without calling Orca', async (argv, message) => {
    const { code, err, port } = await run(argv as string[], [{ paneKey: 'a:1', behavior: working }]);
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(port.listCalls).toBe(0);
    expect(port.sends).toHaveLength(0);
  });

  it('describes close in the usage text', async () => {
    const { out } = await run(['--help']);
    expect(out).toContain('orca-pause close');
  });
});

describe('parseTimeout', () => {
  it.each([
    ['90s', 90_000],
    ['3m', 180_000],
    ['2h', 7_200_000],
  ])('parses %s', (value, ms) => expect(parseTimeout(value)).toBe(ms));
});

describe('resolveStateDir', () => {
  it('uses XDG_STATE_HOME when set and the home default otherwise', () => {
    expect(resolveStateDir({ XDG_STATE_HOME: '/x/state' }, '/home/u')).toBe('/x/state/orca-pause');
    expect(resolveStateDir({}, '/home/u')).toBe('/home/u/.local/state/orca-pause');
  });
});

describe('orca-pause pause', () => {
  it('exits 0 and prints a confirmed table when every agent pauses', async () => {
    const { code, out, dir } = await run(['pause'], [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a', behavior: repliesWithToken() },
      { paneKey: 'b:2', repo: 'beta', worktree: 'wt-b', behavior: repliesWithToken() },
    ]);
    expect(code).toBe(0);
    expect(out).toContain('confirmed (2)');
    expect(out).toMatch(/alpha\s+wt-a\s+worker\s+confirmed/);
    expect(out).not.toContain('unconfirmed');
    expect((await readdir(`${dir}/orca-pause`)).sort()).toHaveLength(2);
  });

  it('exits 1 and lists unconfirmed agents first with an action hint', async () => {
    const { code, out } = await run(['pause', '--timeout', '10s'], [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a', behavior: repliesWithToken() },
      { paneKey: 'b:2', repo: 'beta', worktree: 'wt-b', behavior: working },
    ]);
    expect(code).toBe(1);
    expect(out.indexOf('unconfirmed (1)')).toBeLessThan(out.indexOf('confirmed (1)'));
    expect(out).toContain('check these agents before you leave');
    expect(out).toMatch(/beta\s+wt-b\s+worker\s+unconfirmed\s+still-working/);
  });

  it('honours --timeout', async () => {
    const { clock } = await run(['pause', '--timeout', '30s'], [{ paneKey: 'a:1', behavior: working }]);
    expect(clock.slept).toBeGreaterThanOrEqual(30_000);
    expect(clock.slept).toBeLessThan(40_000);
  });

  it('prints nothing to pause and exits 0', async () => {
    const { code, out } = await run(['pause'], [{ paneKey: 'a:1', behavior: () => ({ state: 'done', message: 'x' }) }]);
    expect(code).toBe(0);
    expect(out).toBe('nothing to pause\n');
  });

  it('prints an Orca error to stderr and exits 2', async () => {
    const { code, err } = await run(['pause'], [{ paneKey: 'a:1', behavior: working }], false, (port) => {
      port.listError = new Error('orca-ide worktree ps failed: boom');
    });
    expect(code).toBe(2);
    expect(err).toContain('boom');
  });

  it('shows an in-place progress line on a TTY and none otherwise', async () => {
    const tty = await run(['pause', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: working }], true);
    expect(tty.err).toMatch(/\r\x1b\[Kpausing… 0\/1 confirmed · 1 still-working · \d+:\d{2} left/);
    const plain = await run(['pause', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: working }], false);
    expect(plain.err).toBe('');
  });
});

const seedRun = (agents: Partial<AgentRecord>[]) => async (store: ReturnType<typeof createRecordStore>) => {
  await store.save({
    runId: 'run-1',
    token: 'abcd1234',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'open',
    agents: agents.map((a) => ({
      worktreeId: 'wt',
      lastHandle: null,
      pauseStatus: 'confirmed',
      pauseReason: null,
      pauseBaseline: 'Stopped here.\nORCA-PAUSED abcd1234',
      messagePending: false,
      confirmedAt: null,
      wakeCount: 0,
      resumeStatus: 'pending',
      role: 'worker',
      ...a,
    })) as AgentRecord[],
  });
  await store.setCurrent('run-1');
};

describe('orca-pause resume', () => {
  it('exits 0 and prints a resumed table when every agent continues', async () => {
    const { code, out, dir } = await run(
      ['resume'],
      [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }],
      false,
      () => {},
      seedRun([{ paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a' }]),
    );
    expect(code).toBe(0);
    expect(out).toContain('resumed (1)');
    expect(out).toMatch(/alpha\s+wt-a\s+worker\s+resumed/);
    expect(await readdir(`${dir}/orca-pause`)).toEqual(['run-1.json']);
  });

  it('exits 1 and lists pending and gone groups first with hints', async () => {
    const { code, out } = await run(
      ['resume'],
      [
        { paneKey: 'a:1', behavior: startsNewTurnAfterContinue },
        { paneKey: 'b:2', behavior: pausedDone('x'), agentIdentity: 'zsh' },
        { paneKey: 'c:3', behavior: () => ({ state: 'waiting', message: 'x' }) },
      ],
      false,
      () => {},
      seedRun([
        { paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a' },
        { paneKey: 'b:2', repo: 'beta', worktree: 'wt-b' },
        { paneKey: 'c:3', repo: 'gamma', worktree: 'wt-c' },
      ]),
    );
    expect(code).toBe(1);
    expect(out.indexOf('pending (1)')).toBeLessThan(out.indexOf('gone (1)'));
    expect(out.indexOf('gone (1)')).toBeLessThan(out.indexOf('resumed (1)'));
    expect(out).toContain('answer the permission prompt');
    expect(out).toContain('restart these agents yourself');
    expect(out).toMatch(/gamma\s+wt-c\s+worker\s+pending\s+waiting-permission/);
    expect(out).toMatch(/beta\s+wt-b\s+worker\s+gone\s+agent-exited/);
  });

  it('prints nothing to resume and exits 0 when no run is open', async () => {
    const { code, out, port } = await run(['resume'], [{ paneKey: 'a:1', behavior: working }]);
    expect(code).toBe(0);
    expect(out).toBe('nothing to resume\n');
    expect(port.listCalls).toBe(0);
  });

  it('prints an Orca error to stderr and exits 2', async () => {
    const { code, err } = await run(['resume'], [{ paneKey: 'a:1', behavior: working }], false, (port) => {
      port.listError = new Error('orca-ide worktree ps failed: boom');
    }, seedRun([{ paneKey: 'a:1' }]));
    expect(code).toBe(2);
    expect(err).toContain('boom');
  });

  it('shows a resuming progress line on a TTY', async () => {
    const { err } = await run(['resume'], [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }], true, () => {}, seedRun([{ paneKey: 'a:1' }]));
    expect(err).toContain('\r\x1b[Kresuming… 0/1 resumed');
    expect(err).toContain('\r\x1b[Kresuming… 1/1 resumed');
  });

  it('lists resume in the usage text', async () => {
    const { out } = await run(['--help']);
    expect(out).toContain('orca-pause resume');
  });
});

describe('orca-pause close', () => {
  const record = (paneKey: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
    paneKey,
    worktreeId: `wt-${paneKey}`,
    worktree: `wt-${paneKey}`,
    repo: 'alpha',
    role: 'worker',
    lastHandle: null,
    pauseStatus: 'confirmed',
    pauseReason: null,
    pauseBaseline: null,
    messagePending: false,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    wakeCount: 0,
    resumeStatus: 'pending',
    ...extra,
  });
  const seedRun = (agents: AgentRecord[]) => async (store: ReturnType<typeof createRecordStore>) => {
    await store.save({ runId: 'run-1', token: 'abcd1234', startedAt: '2026-01-01T00:00:00.000Z', status: 'open', agents });
    await store.setCurrent('run-1');
  };

  it('lists the abandoned agents with their pauseStatus and hints, and touches Orca not at all', async () => {
    const { code, out, port, dir } = await run(
      ['close'],
      [{ paneKey: 'a:1', behavior: working }],
      false,
      () => {},
      seedRun([record('a:1'), record('b:2', { pauseStatus: 'unconfirmed', pauseReason: 'still-working' }), record('c:3', { pauseStatus: 'unconfirmed' }), record('d:4', { resumeStatus: 'resumed' })]),
    );

    expect(code).toBe(0);
    expect(out).toContain('abandoned (3) - still paused — continue it by hand');
    expect(out).toMatch(/alpha\s+wt-a:1\s+worker\s+confirmed\s+paused and waiting for CONTINUE — run resume before close, or continue it by hand/);
    expect(out).toMatch(/wt-b:2\s+worker\s+unconfirmed\s+still-working/);
    expect(out).toMatch(/wt-c:3\s+worker\s+unconfirmed\s+-/);
    expect(out).not.toContain('wt-d:4');
    expect(port.sends).toHaveLength(0);
    expect([port.listCalls, port.listTerminalsCalls, port.listRunsCalls]).toEqual([0, 0, 0]);
    const runFile = JSON.parse(await readFile(`${dir}/orca-pause/run-1.json`, 'utf8'));
    expect(runFile.status).toBe('closed');
    expect(await readdir(`${dir}/orca-pause`)).not.toContain('current');
  });

  it('prints no table and exits 0 when every agent was resumed or gone', async () => {
    const { code, out } = await run(['close'], [], false, () => {}, seedRun([record('a:1', { resumeStatus: 'resumed' })]));
    expect(code).toBe(0);
    expect(out).toBe('');
  });

  it('prints nothing to close and exits 0 when no run is open', async () => {
    const { code, out } = await run(['close']);
    expect(code).toBe(0);
    expect(out).toBe('nothing to close\n');
  });

  it('exits 2 and prints the error on stderr when a record is unreadable', async () => {
    const { code, err, out } = await run(['close'], [], false, () => {}, async (store) => {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(store.dir, { recursive: true });
      await writeFile(`${store.dir}/bad.json`, '{nope');
    });
    expect(code).toBe(2);
    expect(err).toContain('unreadable record');
    expect(out).toBe('');
  });

  it('lets the next pause start a fresh run with a different token', async () => {
    const dir = await tempStateDir();
    const store = createRecordStore(`${dir}/orca-pause`);
    await seedRun([record('a:1')])(store);
    const io = { stdout: () => {}, stderr: () => {}, isTTY: false };
    const port = new FakeOrca([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    const clock = fakeClock();
    const tokens = ['11111111'];

    expect(await main(['close'], { XDG_STATE_HOME: dir }, io, { port, clock })).toBe(0);
    expect(await main(['pause'], { XDG_STATE_HOME: dir }, io, { port, clock, newToken: () => tokens[0] as string })).toBe(0);

    const current = (await readFile(`${dir}/orca-pause/current`, 'utf8')).trim();
    expect(current).not.toBe('run-1');
    const fresh = JSON.parse(await readFile(`${dir}/orca-pause/${current}.json`, 'utf8'));
    expect(fresh.token).toBe('11111111');
    expect(fresh.token).not.toBe('abcd1234');
  });
});
