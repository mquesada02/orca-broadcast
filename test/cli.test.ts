import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, parseTimeout, resolveStateDir } from '../src/cli.js';
import { createOrcaAdapter, type Exec } from '../src/orca-adapter.js';
import { createRecordStore } from '../src/store.js';
import type { AgentRecord } from '../src/types.js';
import { agentRecord, type FakeAgent, seedOpenRun, fakeClock, FakeOrca, pausedDone, repliesWithToken, startsNewTurnAfterContinue, tempStateDir, working } from './helpers/fake-orca.js';
import { noKill } from './helpers/run-cli.js';

async function run(
  argv: string[],
  agents: FakeAgent[] = [],
  isTTY = false,
  configure: (port: FakeOrca) => void = () => {},
  seed: (store: ReturnType<typeof createRecordStore>) => Promise<unknown> = async () => {},
) {
  const dir = await tempStateDir();
  await seed(createRecordStore(`${dir}/orca-broadcast`));
  const out: string[] = [];
  const err: string[] = [];
  const port = new FakeOrca(agents);
  configure(port);
  const clock = fakeClock();
  const code = await main(argv, { XDG_STATE_HOME: dir }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY }, { port, clock, kill: noKill });
  return { code, out: out.join(''), err: err.join(''), dir, port, clock };
}

describe('orca-broadcast --help and usage', () => {
  it('prints usage and exits 0 for --help', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('Usage: orca-broadcast <command>');
    expect(out).toContain('run `orca-broadcast <command> --help` for its options');
    const broadcast = await run(['broadcast', '--help']);
    expect(broadcast.out).toContain('Usage: orca-broadcast broadcast');
    expect(broadcast.out).toContain('--timeout');
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
    const { out } = await run(['close', '--help']);
    expect(out).toContain('Usage: orca-broadcast close');
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
    expect(resolveStateDir({ XDG_STATE_HOME: '/x/state' }, '/home/u')).toBe('/x/state/orca-broadcast');
    expect(resolveStateDir({}, '/home/u')).toBe('/home/u/.local/state/orca-broadcast');
  });
});

describe('orca-broadcast pause', () => {
  it('exits 0 and prints a confirmed table when every agent pauses', async () => {
    const { code, out, dir } = await run(['pause', '--yes'], [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a', behavior: repliesWithToken() },
      { paneKey: 'b:2', repo: 'beta', worktree: 'wt-b', behavior: repliesWithToken() },
    ]);
    expect(code).toBe(0);
    expect(out).toContain('confirmed (2)');
    expect(out).toMatch(/alpha\s+wt-a\s+session\s+run: unknown\s+confirmed/);
    expect(out).not.toContain('unconfirmed');
    expect((await readdir(`${dir}/orca-broadcast`)).sort()).toEqual(['current', 'pauses']);
  });

  it('exits 1 and lists unconfirmed agents first with an action hint', async () => {
    const { code, out } = await run(['pause', '--yes', '--timeout', '10s'], [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a', behavior: repliesWithToken() },
      { paneKey: 'b:2', repo: 'beta', worktree: 'wt-b', behavior: working },
    ]);
    expect(code).toBe(1);
    expect(out.indexOf('unconfirmed (1)')).toBeLessThan(out.indexOf('confirmed (1)'));
    expect(out).toContain('check these agents before you leave');
    expect(out).toMatch(/beta\s+wt-b\s+session\s+run: unknown\s+unconfirmed\s+still-working/);
  });

  it('honours --timeout', async () => {
    const { clock } = await run(['pause', '--yes', '--timeout', '30s'], [{ paneKey: 'a:1', behavior: working }]);
    expect(clock.slept).toBeGreaterThanOrEqual(30_000);
    expect(clock.slept).toBeLessThan(40_000);
  });

  it('prints nothing to pause and exits 0', async () => {
    const { code, out } = await run(['pause', '--yes'], [{ paneKey: 'a:1', behavior: () => ({ state: 'done', message: 'x' }) }]);
    expect(code).toBe(0);
    expect(out).toBe('nothing to pause\n');
  });

  it('prints an Orca error to stderr and exits 2', async () => {
    const { code, err } = await run(['pause', '--yes'], [{ paneKey: 'a:1', behavior: working }], false, (port) => {
      port.listError = new Error('orca-ide worktree ps failed: boom');
    });
    expect(code).toBe(2);
    expect(err).toContain('boom');
  });

  it('shows an in-place progress line on a TTY and none otherwise', async () => {
    const tty = await run(['pause', '--yes', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: working }], true);
    expect(tty.err).toMatch(/\r\x1b\[Kpausing… 0\/1 confirmed · 1 still-working · \d+:\d{2} left/);
    const plain = await run(['pause', '--yes', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: working }], false);
    expect(plain.err).toBe('');
  });
});

const seedRun = (agents: Partial<AgentRecord>[]) => async (store: ReturnType<typeof createRecordStore>) => {
  await store.save({
    runId: 'run-1',
    token: 'abcd1234',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'open',
    scope: [{ typed: {} }],
    agents: agents.map((a) => ({
      repoId: 'repo-x',
      worktreePath: '/work/wt',
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
  await store.setCurrent('pause', 'run-1');
};

describe('orca-broadcast resume', () => {
  it('exits 0 and prints a resumed table when every agent continues', async () => {
    const { code, out, dir } = await run(
      ['resume', '--yes'],
      [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }],
      false,
      () => {},
      seedRun([{ paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a' }]),
    );
    expect(code).toBe(0);
    expect(out).toContain('resumed (1)');
    expect(out).toMatch(/alpha\s+wt-a\s+session\s+run: unknown\s+resumed/);
    expect(await readdir(`${dir}/orca-broadcast/pauses`)).toEqual(['run-1.json']);
  });

  it('exits 1 and lists pending and gone groups first with hints', async () => {
    const { code, out } = await run(
      ['resume', '--yes'],
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
    expect(out).toMatch(/gamma\s+wt-c\s+session\s+run: unknown\s+pending\s+waiting-permission/);
    expect(out).toMatch(/beta\s+wt-b\s+worker\s+run: unknown\s+gone\s+agent-exited/);
  });

  it('prints nothing to resume and exits 0 when no run is open', async () => {
    const { code, out, port } = await run(['resume', '--yes'], [{ paneKey: 'a:1', behavior: working }]);
    expect(code).toBe(0);
    expect(out).toBe('nothing to resume\n');
    expect(port.listCalls).toBe(0);
  });

  it('prints an Orca error to stderr and exits 2', async () => {
    const { code, err } = await run(['resume', '--yes'], [{ paneKey: 'a:1', behavior: working }], false, (port) => {
      port.listError = new Error('orca-ide worktree ps failed: boom');
    }, seedRun([{ paneKey: 'a:1' }]));
    expect(code).toBe(2);
    expect(err).toContain('boom');
  });

  it('shows a resuming progress line on a TTY', async () => {
    const { err } = await run(['resume', '--yes'], [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }], true, () => {}, seedRun([{ paneKey: 'a:1' }]));
    expect(err).toContain('\r\x1b[Kresuming… 0/1 resumed');
    expect(err).toContain('\r\x1b[Kresuming… 1/1 resumed');
  });

  it('lists resume in the usage text', async () => {
    const { out } = await run(['resume', '--help']);
    expect(out).toContain('Usage: orca-broadcast resume');
  });
});

describe('orca-broadcast close', () => {
  const seedRun = (agents: AgentRecord[]) => (store: ReturnType<typeof createRecordStore>) => seedOpenRun(store, agents);

  it('lists the abandoned agents with their pauseStatus and hints, and touches Orca not at all', async () => {
    const { code, out, port, dir } = await run(
      ['close'],
      [{ paneKey: 'a:1', behavior: working }],
      false,
      () => {},
      seedRun([agentRecord('a:1'), agentRecord('b:2', { pauseStatus: 'unconfirmed', pauseReason: 'still-working' }), agentRecord('c:3', { pauseStatus: 'unconfirmed' }), agentRecord('d:4', { resumeStatus: 'resumed' })]),
    );

    expect(code).toBe(0);
    expect(out).toContain('abandoned (3) - still paused — continue it by hand');
    expect(out).toMatch(/repo\s+tree-a:1\s+worker\s+run: unknown\s+confirmed\s+paused and waiting for CONTINUE — run resume before close, or continue it by hand/);
    expect(out).toMatch(/tree-b:2\s+worker\s+run: unknown\s+unconfirmed\s+still-working/);
    expect(out).toMatch(/tree-c:3\s+worker\s+run: unknown\s+unconfirmed\s+-/);
    expect(out).toContain('3 agents have a role but no known run\n');
    expect(out).not.toContain('tree-d:4');
    expect(port.sends).toHaveLength(0);
    expect([port.listCalls, port.listTerminalsCalls, port.listRunsCalls]).toEqual([0, 0, 0]);
    const runFile = JSON.parse(await readFile(`${dir}/orca-broadcast/pauses/run-1.json`, 'utf8'));
    expect(runFile.status).toBe('closed');
    expect(await readdir(`${dir}/orca-broadcast`)).not.toContain('current');
  });

  it('prints no table and exits 0 when every agent was resumed or gone', async () => {
    const { code, out } = await run(['close'], [], false, () => {}, seedRun([agentRecord('a:1', { resumeStatus: 'resumed' }), agentRecord('b:2', { resumeStatus: 'gone' })]));
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
      await mkdir(`${store.dir}/pauses`, { recursive: true });
      await writeFile(`${store.dir}/pauses/bad.json`, '{nope');
    });
    expect(code).toBe(2);
    expect(err).toContain('unreadable record');
    expect(out).toBe('');
  });

  it('lets the next pause start a fresh run with a different token', async () => {
    const dir = await tempStateDir();
    const store = createRecordStore(`${dir}/orca-broadcast`);
    await seedOpenRun(store, [agentRecord('a:1')]);
    const io = { stdout: () => {}, stderr: () => {}, isTTY: false };
    const port = new FakeOrca([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    const clock = fakeClock();
    const tokens = ['11111111'];

    expect(await main(['close'], { XDG_STATE_HOME: dir }, io, { port, clock, kill: noKill })).toBe(0);
    expect(await main(['pause', '--yes'], { XDG_STATE_HOME: dir }, io, { port, clock, newToken: () => tokens[0] as string, kill: noKill })).toBe(0);

    const current = (JSON.parse(await readFile(`${dir}/orca-broadcast/current`, 'utf8')) as { id: string }).id;
    expect(current).not.toBe('run-1');
    const fresh = JSON.parse(await readFile(`${dir}/orca-broadcast/pauses/${current}.json`, 'utf8'));
    expect(fresh.token).toBe('11111111');
    expect(fresh.token).not.toBe('abcd1234');
  });
});

describe('safety rails', () => {
  async function invoke(argv: string[], agents: FakeAgent[], dir: string, extra: Partial<Parameters<typeof main>[3]> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const port = new FakeOrca(agents);
    const clock = fakeClock();
    const signals = new EventEmitter();
    const code = await main(argv, { XDG_STATE_HOME: dir }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: false }, { port, clock, signals, kill: noKill, ...extra });
    return { code, out: out.join(''), err: err.join(''), port, clock, signals, stateDir: join(dir, 'orca-broadcast') };
  }

  const lockFile = async (dir: string, content: string) => {
    await mkdir(join(dir, 'orca-broadcast'), { recursive: true });
    await writeFile(join(dir, 'orca-broadcast', 'lock'), content);
  };

  it('exits 2 with "another orca-broadcast is running" while a live process holds the lock, and touches nothing', async () => {
    const dir = await tempStateDir();
    await lockFile(dir, `${process.pid}\n`);
    const { code, err, port } = await invoke(['pause', '--yes'], [{ paneKey: 'a:1', behavior: working }], dir);
    expect(code).toBe(2);
    expect(err).toContain('another orca-broadcast is running');
    expect(port.listCalls).toBe(0);
    expect(await readdir(join(dir, 'orca-broadcast'))).toEqual(['lock']);
  });

  it('takes over a lock left by a dead process and releases the lock when done', async () => {
    const dir = await tempStateDir();
    await lockFile(dir, `${spawnSync(process.execPath, ['-e', '']).pid}\n`);
    const { code, stateDir } = await invoke(['pause', '--yes'], [{ paneKey: 'a:1', behavior: repliesWithToken() }], dir);
    expect(code).toBe(0);
    expect((await readdir(stateDir)).filter((n) => n === 'lock' || n.startsWith('lock.'))).toEqual([]);
  });

  it('does not take or leave the lock for a usage error or --help', async () => {
    const dir = await tempStateDir();
    for (const argv of [['pause', '--timeout', '5x'], ['--help']]) {
      await invoke(argv, [], dir);
    }
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('exits 2 with a usage message for --timeout 5x before calling Orca', async () => {
    const { code, err, port } = await invoke(['pause', '--yes', '--timeout', '5x'], [{ paneKey: 'a:1', behavior: working }], await tempStateDir());
    expect(code).toBe(2);
    expect(err).toContain('invalid --timeout');
    expect(err).toContain('Usage: orca-broadcast');
    expect(port.listCalls).toBe(0);
  });

  it('on SIGTERM mid-wait saves the record, exits 130 and releases the lock; a re-run extends the record and sends nothing', async () => {
    const dir = await tempStateDir();
    const emitter = new EventEmitter();
    const first = await invoke(['pause', '--yes'], [{ paneKey: 'a:1', behavior: working }], dir, {
      clock: Object.assign(fakeClock(), { onSleep: () => emitter.emit('SIGTERM') }),
      signals: emitter,
    });
    expect(first.code).toBe(130);
    expect(first.err).toContain('interrupted by SIGTERM');
    expect((await readdir(first.stateDir)).sort()).toEqual(['current', 'pauses']);
    const [name] = await readdir(join(first.stateDir, 'pauses'));
    const record = JSON.parse(await readFile(join(first.stateDir, 'pauses', name as string), 'utf8'));
    expect(record).toMatchObject({ status: 'open' });
    expect(record.agents).toHaveLength(1);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);

    const second = await invoke(['pause', '--yes'], [{ paneKey: 'a:1', behavior: working }], dir);
    expect(second.code).toBe(1);
    expect(second.port.sends).toHaveLength(0);
    expect(await readdir(join(second.stateDir, 'pauses'))).toEqual([name]);
  });

  it.each(['SIGINT', 'SIGHUP'] as const)('treats %s like SIGTERM', async (name) => {
    const emitter = new EventEmitter();
    const { code } = await invoke(['pause', '--yes'], [{ paneKey: 'a:1', behavior: working }], await tempStateDir(), {
      clock: Object.assign(fakeClock(), { onSleep: () => emitter.emit(name) }),
      signals: emitter,
    });
    expect(code).toBe(130);
  });

  describe('close', () => {
    const seedClose = (dir: string) => seedOpenRun(createRecordStore(join(dir, 'orca-broadcast')), [agentRecord('a:1')]);

    it('exits 2 while a live process holds the lock and leaves the run open', async () => {
      const dir = await tempStateDir();
      await seedClose(dir);
      await lockFile(dir, `${process.pid}\n`);
      const { code, err, stateDir } = await invoke(['close'], [], dir);
      expect(code).toBe(2);
      expect(err).toContain('another orca-broadcast is running');
      expect(JSON.parse(await readFile(join(stateDir, 'pauses', 'run-1.json'), 'utf8')).status).toBe('open');
    });

    it('on a signal exits 130, leaves the run open and releases the lock', async () => {
      const dir = await tempStateDir();
      await seedClose(dir);
      const signals = Object.assign(new EventEmitter(), {
        on(name: string, handler: () => void) {
          if (name === 'SIGTERM') handler();
          return this;
        },
      });
      const { code, err, stateDir } = await invoke(['close'], [], dir, { signals });
      expect(code).toBe(130);
      expect(err).toContain('interrupted by SIGTERM');
      expect(JSON.parse(await readFile(join(stateDir, 'pauses', 'run-1.json'), 'utf8')).status).toBe('open');
      expect((await readdir(stateDir)).sort()).toEqual(['current', 'pauses']);
    });

    it('closes the run under the lock and releases it', async () => {
      const dir = await tempStateDir();
      await seedClose(dir);
      const { code, stateDir } = await invoke(['close'], [], dir);
      expect(code).toBe(0);
      expect(JSON.parse(await readFile(join(stateDir, 'pauses', 'run-1.json'), 'utf8')).status).toBe('closed');
      expect(await readdir(stateDir)).toEqual(['pauses']);
    });
  });

  describe('resume', () => {
    const seed = async (dir: string) => {
      const store = createRecordStore(join(dir, 'orca-broadcast'));
      await store.save({
        runId: 'run-1',
        token: 'abcd1234',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'open',
        scope: [{ typed: {} }],
        agents: [
          {
            paneKey: 'a:1', repoId: 'repo-alpha', worktreePath: '/work/wt-a', worktreeId: 'wt', worktree: 'wt-a', repo: 'alpha', role: 'worker', orchestrationRunIds: [], lastHandle: null, pauseStatus: 'confirmed', pauseReason: null,
            pauseBaseline: 'Stopped here.\nORCA-PAUSED abcd1234', messagePending: false, confirmedAt: null, wakeCount: 0, resumeStatus: 'pending',
          },
        ],
      });
      await store.setCurrent('pause', 'run-1');
    };

    it('exits 2 while a live process holds the lock and sends nothing', async () => {
      const dir = await tempStateDir();
      await seed(dir);
      await lockFile(dir, `${process.pid}\n`);
      const { code, err, port } = await invoke(['resume', '--yes'], [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }], dir);
      expect(code).toBe(2);
      expect(err).toContain('another orca-broadcast is running');
      expect(port.sends).toHaveLength(0);
    });

    it('on SIGTERM saves the record, exits 130 and releases the lock', async () => {
      const dir = await tempStateDir();
      await seed(dir);
      const emitter = new EventEmitter();
      const { code, err, stateDir, port } = await invoke(['resume', '--yes'], [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }], dir, {
        clock: Object.assign(fakeClock(), { onSleep: () => emitter.emit('SIGTERM') }),
        signals: emitter,
      });
      expect(code).toBe(130);
      expect(err).toContain('interrupted by SIGTERM');
      expect(port.sends).toHaveLength(1);
      expect((await readdir(stateDir)).sort()).toEqual(['current', 'pauses']);
      expect(emitter.listenerCount('SIGTERM')).toBe(0);
      expect(JSON.parse(await readFile(join(stateDir, 'pauses', 'run-1.json'), 'utf8')).status).toBe('open');
    });
  });

  it('stops with exit 2 and the record saved when worktree ps becomes truncated', async () => {
    const dir = await tempStateDir();
    let psCalls = 0;
    const ps = (truncated: boolean) =>
      JSON.stringify({
        ok: true,
        result: {
          truncated,
          hostScope: { omittedHostIds: [] },
          worktrees: [{ worktreeId: 'w1', displayName: 'tree', repo: 'repo', agents: [{ paneKey: 'a:1', agentType: 'claude', state: 'working', stateStartedAt: 1, lastAssistantMessage: null }] }],
        },
      });
    const sendReceipt = readFileSync(join(import.meta.dirname, 'fixtures', 'terminal-send-accepted.json'), 'utf8');
    const exec: Exec = async (_file, args) => {
      const key = args.slice(0, 2).join(' ');
      const stdout =
        key === 'worktree ps' ? ps(++psCalls > 1) : key === 'terminal list' ? JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term_a', tabId: 'a', leafId: '1', agentIdentity: 'claude' }] } }) : sendReceipt;
      return { stdout, stderr: '', code: 0 };
    };
    const { code, err, stateDir } = await invoke(['pause', '--yes'], [], dir, { port: createOrcaAdapter(exec) });
    expect(code).toBe(2);
    expect(err).toContain('incomplete');
    const [name] = await readdir(join(stateDir, 'pauses'));
    const record = JSON.parse(await readFile(join(stateDir, 'pauses', name as string), 'utf8'));
    expect(record.agents[0]).toMatchObject({ paneKey: 'a:1', messagePending: true });
  });
});

describe('--reason', () => {
  const agents = (): FakeAgent[] => [{ paneKey: 'a:1', behavior: repliesWithToken() }];

  it('lists the presets in --help', async () => {
    const { out } = await run(['pause', '--help']);
    for (const name of ['--reason <name>', 'network', 'away', 'end-of-day', 'limit', 'restart']) expect(out).toContain(name);
  });

  it('sends the preset sentence and stores it in the record', async () => {
    const { code, port, dir } = await run(['pause', '--yes', '--reason', 'end-of-day'], agents());
    expect(code).toBe(0);
    expect(port.sends[0]?.text).toContain('[orca-broadcast] The user is stopping work for the day. Finish');
    expect(JSON.parse(await readFile(`${dir}/orca-broadcast/pauses/${(await readdir(`${dir}/orca-broadcast/pauses`)).find((n) => n.endsWith('.json'))}`, 'utf8')).reason).toBe('end-of-day');
  });

  const bad: [string, string[], string][] = [
    ['an unknown name', ['pause', '--yes', '--reason', 'bogus'], 'use one of network, away, end-of-day, limit, restart'],
    ['an empty name', ['pause', '--yes', '--reason', ''], 'use one of network, away, end-of-day, limit, restart'],
    ['resume', ['resume', '--yes', '--reason', 'away'], '--reason applies only to pause'],
    ['close', ['close', '--reason', 'away'], '--reason applies only to pause'],
    ['resume with an unknown name', ['resume', '--yes', '--reason', 'bogus'], '--reason applies only to pause'],
  ];
  for (const [name, argv, message] of bad) {
    it(`exits 2 for ${name}, before calling Orca`, async () => {
      const plain = await run(argv, agents());
      expect(plain.code).toBe(2);
      expect(plain.err).toContain(message);
      expect(plain.port.listCalls).toBe(0);
      expect(plain.port.sends).toHaveLength(0);

      const json = await run([...argv, '--json'], agents());
      expect(json.code).toBe(2);
      expect(json.err).toBe('');
      expect(JSON.parse(json.out)).toMatchObject({ outcome: 'error', exitCode: 2, run: null });
      expect(JSON.parse(json.out).error).toContain(message);
    });
  }

  it('ignores --reason when there is no open run and no working agent', async () => {
    const { code, out } = await run(['pause', '--yes', '--reason', 'away']);
    expect(code).toBe(0);
    expect(out).toBe('nothing to pause\n');
  });

  it('prints the refusal on stderr for a run without a reason', async () => {
    const { code, out, err, port } = await run(['pause', '--yes', '--reason', 'network'], agents(), false, () => {}, (store) => seedOpenRun(store, [agentRecord('a:1')]));
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toBe('orca-broadcast: This run was paused without --reason; run pause without --reason, or close it first.\n');
    expect(port.sends).toHaveLength(0);
  });

  it('prints the refusal on stderr for a run with a reason', async () => {
    const { code, err } = await run(['pause', '--yes', '--reason', 'limit'], agents(), false, () => {}, (store) => seedOpenRun(store, [agentRecord('a:1')], { reason: 'away' }));
    expect(code).toBe(2);
    expect(err).toBe('orca-broadcast: This run was paused with --reason away; use --reason away, or close it first.\n');
  });

  it('refuses a different reason on an open run with one JSON error object and sends nothing', async () => {
    const { code, out, err, port } = await run(['pause', '--yes', '--json', '--reason', 'limit'], agents(), false, () => {}, (store) =>
      seedOpenRun(store, [agentRecord('a:1')], { reason: 'away' }),
    );
    expect(code).toBe(2);
    expect(err).toBe('');
    expect(JSON.parse(out)).toMatchObject({ command: 'pause', outcome: 'error', exitCode: 2, error: 'This run was paused with --reason away; use --reason away, or close it first.' });
    expect(port.sends).toHaveLength(0);
  });
});
