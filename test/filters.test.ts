import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { close } from '../src/close.js';
import { createRecordStore } from '../src/store.js';
import type { Run } from '../src/types.js';
import { agentRecord, type FakeAgent, FakeOrca, fakeClock, pausedDone, repliesWithToken, seedOpenRun, tempStateDir, working, wokenWorking } from './helpers/fake-orca.js';
import { runCli, type RunCliOptions } from './helpers/run-cli.js';

const REPOS = [
  { id: 'repo-alpha', path: '/r/alpha', displayName: 'alpha' },
  { id: 'repo-beta', path: '/r/beta', displayName: 'beta' },
  { id: 'repo-gamma', path: '/r/gamma', displayName: 'gamma' },
];

const fleet = (): FakeAgent[] => [
  { paneKey: 'a:1', repo: 'alpha', worktree: 'main', behavior: repliesWithToken() },
  { paneKey: 'a:2', repo: 'alpha', worktree: 'feature', behavior: repliesWithToken() },
  { paneKey: 'b:1', repo: 'beta', worktree: 'main', behavior: repliesWithToken() },
  { paneKey: 'g:1', repo: 'gamma', worktree: 'main', behavior: repliesWithToken() },
];

const withRepos = (opts: RunCliOptions = {}): RunCliOptions => ({
  ...opts,
  configure: (port) => {
    port.repos = [...REPOS];
    opts.configure?.(port);
  },
});

async function readRuns(dir: string): Promise<Run[]> {
  const folder = join(dir, 'orca-broadcast', 'pauses');
  const names = (await readdir(folder).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(folder, n), 'utf8')) as Run));
}

const sentPanes = (port: FakeOrca) => [...new Set(port.sends.map((s) => s.handle.replace('term_', '')))].sort();

describe('filter values', () => {
  it('--repo accepts an id, an absolute path or a display name', async () => {
    for (const value of ['repo-alpha', '/r/alpha', 'alpha']) {
      const { code, port } = await runCli(['pause', '--yes', '--repo', value], fleet(), withRepos());
      expect(code, value).toBe(0);
      expect(sentPanes(port), value).toEqual(['a:1', 'a:2']);
    }
  });

  it('--repo is repeatable: values of one kind are ORed', async () => {
    const { code, port } = await runCli(['pause', '--yes', '--repo', 'alpha', '--repo', 'beta'], fleet(), withRepos());
    expect(code).toBe(0);
    expect(sentPanes(port)).toEqual(['a:1', 'a:2', 'b:1']);
  });

  it('kinds are ANDed: --repo with --role', async () => {
    const { port } = await runCli(['pause', '--yes', '--repo', 'alpha', '--repo', 'beta', '--role', 'worker'], fleet(), withRepos({ configure: (p) => (p.workersAt = () => [{ paneKey: 'a:2' }, { paneKey: 'g:1' }]) }));
    expect(sentPanes(port)).toEqual(['a:2']);
  });

  it('--role session picks the agents that are neither coordinators nor workers', async () => {
    const { port } = await runCli(['pause', '--yes', '--role', 'session'], fleet(), withRepos({ configure: (p) => (p.workersAt = () => [{ paneKey: 'a:2' }]) }));
    expect(sentPanes(port)).toEqual(['a:1', 'b:1', 'g:1']);
  });

  it('--run matches an exact orchestration run id of the run list or the worker list', async () => {
    const { port } = await runCli(['pause', '--yes', '--run', 'run_w1'], fleet(), withRepos({ configure: (p) => (p.workersAt = () => [{ paneKey: 'b:1', runId: 'run_w1' }, { paneKey: 'g:1', runId: 'run_w2' }]) }));
    expect(sentPanes(port)).toEqual(['b:1']);
  });

  it('--run also matches a run id of the run list', async () => {
    const { code, port } = await runCli(['pause', '--yes', '--run', 'run_listed'], fleet(), withRepos({ configure: (p) => (p.runsAt = () => [{ id: 'run_listed', coordinatorHandle: p.handleOf('g:1') }]) }));
    expect(code).toBe(0);
    expect(sentPanes(port)).toEqual(['g:1']);
  });

  it('--worktree accepts an id, a path from the injected folder, and a name scoped by --repo', async () => {
    const byId = await runCli(['pause', '--yes', '--worktree', 'wt-b:1'], fleet(), withRepos());
    expect(sentPanes(byId.port)).toEqual(['b:1']);

    const byPath = await runCli(['pause', '--yes', '--worktree', '.'], fleet(), withRepos({ cwd: '/work/feature' }));
    expect(sentPanes(byPath.port)).toEqual(['a:2']);
    const byRelative = await runCli(['pause', '--yes', '--worktree', 'feature'], fleet(), withRepos({ cwd: '/work' }));
    expect(sentPanes(byRelative.port)).toEqual(['a:2']);

    const byName = await runCli(['pause', '--yes', '--repo', 'beta', '--worktree', 'main'], fleet(), withRepos());
    expect(sentPanes(byName.port)).toEqual(['b:1']);
  });

  it('a worktree name shared by several repos is ambiguous, and exits 2 with the candidates before anything is sent', async () => {
    const { code, err, port, dir } = await runCli(['pause', '--yes', '--worktree', 'main'], fleet(), withRepos());
    expect(code).toBe(2);
    expect(err).toContain('ambiguous --worktree "main"');
    expect(err).toContain('wt-a:1');
    expect(err).toContain('wt-b:1');
    expect(port.sends).toEqual([]);
    expect(await readRuns(dir)).toEqual([]);
  });

  it('a value that fits several ids is ambiguous, whatever its form', async () => {
    const { code, err } = await runCli(['pause', '--yes', '--repo', 'alpha'], fleet(), withRepos({ configure: (p) => p.repos.push({ id: 'alpha', path: '/r/other', displayName: 'other' }) }));
    expect(code).toBe(2);
    expect(err).toContain('ambiguous --repo "alpha"');
  });

  it.each([
    [['--repo', 'nope'], 'unknown --repo "nope"'],
    [['--worktree', 'nope'], 'unknown --worktree "nope"'],
    [['--run', 'run_nope'], 'unknown --run "run_nope"'],
  ])('an unknown value %j exits 2 and sends nothing', async (flags, message) => {
    const { code, err, port } = await runCli(['pause', '--yes', ...flags], fleet(), withRepos());
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(port.sends).toEqual([]);
  });

  it('a filter that selects nobody prints "nothing to pause" with the filters used and exits 0', async () => {
    const { code, out, port, dir } = await runCli(['pause', '--yes', '--repo', 'gamma', '--role', 'coordinator'], fleet(), withRepos());
    expect(code).toBe(0);
    expect(out).toContain('nothing to pause');
    expect(out).toContain('filters: --repo gamma --role coordinator');
    expect(port.sends).toEqual([]);
    expect(await readRuns(dir)).toEqual([]);
  });
});

// A worktree in which no agent runs.
const IDLE = { id: 'repo-alpha::/work/idle', repoId: 'repo-alpha', path: '/work/idle', displayName: 'idle' };
const withIdle = (opts: RunCliOptions = {}): RunCliOptions =>
  withRepos({
    ...opts,
    configure: (port) => {
      port.worktrees = [...port.agentWorktrees(), IDLE];
      opts.configure?.(port);
    },
  });

describe('an idle worktree', () => {
  it.each([
    ['a path', ['--worktree', '/work/idle'], 'filters: --worktree /work/idle'],
    ['an id', ['--worktree', 'repo-alpha::/work/idle'], 'filters: --worktree repo-alpha::/work/idle'],
    ['a name scoped by --repo', ['--repo', 'alpha', '--worktree', 'idle'], 'filters: --repo alpha --worktree idle'],
  ])('can be named by %s: "nothing to pause", the filters used, exit 0, nothing written', async (_label, flags, filtersLine) => {
    const { code, out, port, dir } = await runCli(['pause', '--yes', ...flags], fleet(), withIdle());
    expect(code).toBe(0);
    expect(out).toContain('nothing to pause');
    expect(out).toContain(filtersLine);
    expect(port.sends).toEqual([]);
    expect(await readRuns(dir)).toEqual([]);
  });

  it('is unknown without the worktree list (exit 2), and an unrelated name is still unknown', async () => {
    const without = await runCli(['pause', '--yes', '--worktree', '/work/idle'], fleet(), withRepos());
    expect(without.code).toBe(2);
    expect(without.err).toContain('unknown --worktree "/work/idle"');
    const other = await runCli(['pause', '--yes', '--worktree', 'nope'], fleet(), withIdle());
    expect(other.code).toBe(2);
  });

  it('on an open run, appends a scope set that sweeps an agent that is in that worktree', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' })]);
    };
    const agents: FakeAgent[] = [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'main', behavior: pausedDone() },
      { paneKey: 'n:1', repo: 'alpha', worktree: 'idle', behavior: repliesWithToken() },
    ];
    const worktrees = (p: FakeOrca) => (p.worktrees = [...p.agentWorktrees().filter((w) => w.id !== 'wt-n:1'), { ...IDLE, id: 'wt-n:1' }]);
    const { code, port, dir } = await runCli(['pause', '--yes', '--repo', 'alpha', '--worktree', 'idle'], agents, withIdle({ seed, configure: worktrees }));
    expect(code).toBe(0);
    expect(sentPanes(port)).toEqual(['n:1']);
    const [run] = await readRuns(dir);
    expect(run?.scope.at(-1)).toMatchObject({ repoIds: ['repo-alpha'], worktreeIds: ['wt-n:1'] });
    expect(run?.agents.map((a) => a.paneKey)).toEqual(['a:1', 'n:1']);
  });

  it('resume and close print "nothing to <command>" with the filters when the worktree has no recorded agent', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' })]);
    };
    const resumed = await runCli(['resume', '--yes', '--worktree', '/work/idle'], [], withIdle({ seed }));
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain('nothing to resume');
    const closed = await runCli(['close', '--worktree', 'repo-alpha::/work/idle'], [], withIdle({ seed }));
    expect(closed.code).toBe(0);
    expect(closed.out).toContain('nothing to close');
  });

  it('is listed once before the lock and once for the run, and only when a filter is given', async () => {
    const plain = await runCli(['pause', '--yes'], fleet(), withIdle());
    expect(plain.port.listWorktreesCalls).toBe(0);
    expect(plain.port.listReposCalls).toBe(0);
    const filtered = await runCli(['pause', '--yes', '--role', 'worker'], fleet(), withIdle());
    expect(filtered.port.listWorktreesCalls).toBe(2);
  });

  it('resume and close list worktrees and repos once, and only with a filter', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' })]);
    };
    for (const command of ['resume', 'close']) {
      const filtered = await runCli([command, ...(command === 'resume' ? ['--yes'] : []), '--worktree', '/work/idle'], [], withIdle({ seed }));
      expect([command, filtered.port.listWorktreesCalls, filtered.port.listReposCalls]).toEqual([command, 1, 1]);
      const plain = await runCli([command, ...(command === 'resume' ? ['--yes'] : [])], [], withIdle({ seed }));
      expect([command, plain.port.listWorktreesCalls, plain.port.listReposCalls]).toEqual([command, 0, 0]);
    }
  });

  it('fails resume when the worktree list fails, and names a worktree from the record alone when the list fails on close', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', worktreeId: 'repo-alpha::/work/saved', worktree: 'saved', worktreePath: '/work/saved' })]);
    };
    const resumed = await runCli(['resume', '--yes', '--worktree', '/work/saved'], [], withIdle({ seed, configure: (p) => (p.failWorktreeList = true) }));
    expect(resumed.code).toBe(2);
    expect(resumed.port.sends).toEqual([]);
    const closed = await runCli(['close', '--worktree', '/work/saved'], [], withIdle({ seed, configure: (p) => (p.failWorktreeList = true) }));
    expect(closed.code).toBe(0);
    expect((await readRuns(closed.dir))[0]?.agents[0]?.resumeStatus).toBe('abandoned');
  });

  it('fails pause when the worktree list fails, and a filtered close falls back to the saved record', async () => {
    const pausedRun = await runCli(['pause', '--yes', '--repo', 'alpha'], fleet(), withIdle({ configure: (p) => (p.failWorktreeList = true) }));
    expect(pausedRun.code).toBe(2);
    expect(pausedRun.port.sends).toEqual([]);
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' }), agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta' })]);
    };
    const closed = await runCli(['close', '--repo', 'repo-alpha'], [], withIdle({ seed, configure: (p) => (p.failWorktreeList = true) }));
    expect(closed.code).toBe(0);
    expect((await readRuns(closed.dir))[0]?.agents.map((a) => a.resumeStatus)).toEqual(['abandoned', 'pending']);
  });
});

describe('flag table', () => {
  it.each([
    [['pause', '--state', 'working'], '--state applies only to broadcast'],
    [['resume', '--state', 'done'], '--state applies only to broadcast'],
    [['close', '--state', 'done'], '--state applies only to broadcast'],
    [['close', '--yes'], '--yes applies only to pause, resume and broadcast'],
    [['resume', '--timeout', '5s'], '--timeout applies only to pause'],
    [['close', '--reason', 'away'], '--reason applies only to pause'],
    [['pause', '--role', 'boss'], 'invalid --role "boss"'],
    [['broadcast', 'hi', '--state', 'busy'], 'invalid --state "busy": use one of working, done'],
  ])('%j exits 2 with a message from the table', async (argv, message) => {
    const { code, err, port } = await runCli(argv as string[], fleet(), withRepos());
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(port.listCalls).toBe(0);
  });

  it('refuses a bad --role even when no run is open', async () => {
    const { code } = await runCli(['resume', '--role', 'boss'], [], withRepos());
    expect(code).toBe(2);
  });
});

describe('pause scope', () => {
  it('stores each filter set resolved, with the typed values, and a plain pause adds the empty set', async () => {
    const first = await runCli(['pause', '--yes', '--repo', 'alpha'], fleet(), withRepos());
    const [run] = await readRuns(first.dir);
    expect(run?.scope).toEqual([{ repoIds: ['repo-alpha'], typed: { repo: ['alpha'] } }]);
  });

  it('a second pause with other filters widens the run by union, and a plain pause widens it to all', async () => {
    const agents = fleet();
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' })], { scope: [{ repoIds: ['repo-alpha'], typed: { repo: ['alpha'] } }] });
    };
    const union = await runCli(['pause', '--yes', '--repo', 'beta'], agents, withRepos({ seed }));
    const [run] = await readRuns(union.dir);
    expect(run?.scope).toHaveLength(2);
    expect(run?.agents.map((a) => a.paneKey).sort()).toEqual(['a:1', 'a:2', 'b:1']);

    const plain = await runCli(['pause', '--yes'], fleet(), withRepos({ seed }));
    const [all] = await readRuns(plain.dir);
    expect(all?.scope.at(-1)).toEqual({ typed: {} });
    expect(all?.agents.map((a) => a.paneKey).sort()).toEqual(['a:1', 'a:2', 'b:1', 'g:1']);
  });

  it('the sweep pauses a new working agent only when it matches a set of the run', async () => {
    const agents: FakeAgent[] = [
      { paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() },
      { paneKey: 'a:9', repo: 'alpha', behavior: repliesWithToken() },
      { paneKey: 'g:1', repo: 'gamma', behavior: repliesWithToken() },
    ];
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' })], { scope: [{ repoIds: ['repo-alpha'], typed: { repo: ['alpha'] } }] });
    };
    const { port, dir } = await runCli(['pause', '--yes', '--repo', 'alpha'], agents, withRepos({ seed }));
    expect(sentPanes(port)).toEqual(['a:9']); // a:1 is already confirmed in the record
    const [run] = await readRuns(dir);
    expect(run?.agents.map((a) => a.paneKey)).toEqual(['a:1', 'a:9']);
  });

  it('the sweep also uses the sets of earlier pauses, and the real role and run ids', async () => {
    const agents: FakeAgent[] = [
      { paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() },
      { paneKey: 'b:9', repo: 'beta', behavior: repliesWithToken() },
      { paneKey: 'g:1', repo: 'gamma', behavior: repliesWithToken() },
      { paneKey: 'w:1', repo: 'gamma', behavior: repliesWithToken() },
    ];
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' })], {
        scope: [{ repoIds: ['repo-beta'], typed: { repo: ['beta'] } }, { roles: ['worker'], runIds: ['run_w1'], typed: { role: ['worker'], run: ['run_w1'] } }],
      });
    };
    const { port, dir } = await runCli(['pause', '--yes', '--repo', 'alpha'], agents, withRepos({ seed, configure: (p) => (p.workersAt = () => [{ paneKey: 'w:1', runId: 'run_w1' }]) }));
    expect(sentPanes(port)).toEqual(['b:9', 'w:1']); // g:1 matches no set; a:1 is already confirmed
    expect((await readRuns(dir))[0]?.agents.map((a) => a.paneKey)).toEqual(['a:1', 'b:9', 'w:1']);
  });

  it('resets a matching resumed agent to pending and leaves a non-matching one resumed', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [
        agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', resumeStatus: 'resumed' }),
        agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta', resumeStatus: 'resumed' }),
        agentRecord('g:1', { repoId: 'repo-gamma', repo: 'gamma' }),
      ]);
    };
    const agents: FakeAgent[] = [
      { paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() },
      { paneKey: 'b:1', repo: 'beta', behavior: repliesWithToken() },
      { paneKey: 'g:1', repo: 'gamma', behavior: pausedDone() },
    ];
    const { port, dir } = await runCli(['pause', '--yes', '--repo', 'alpha'], agents, withRepos({ seed }));
    expect(sentPanes(port)).toEqual(['a:1']);
    expect((await readRuns(dir))[0]?.agents.map((a) => a.resumeStatus)).toEqual(['pending', 'resumed', 'pending']);
  });

  it('records the repo id and worktree path of every agent', async () => {
    const { dir } = await runCli(['pause', '--yes', '--repo', 'alpha'], fleet(), withRepos());
    const [run] = await readRuns(dir);
    expect(run?.agents[0]).toMatchObject({ repoId: 'repo-alpha', worktreePath: '/work/main', worktreeId: 'wt-a:1' });
  });

  it('a filter that matches nobody on an open run still appends its set and extends the run, with exit 0', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('x:1', { repoId: 'repo-alpha', repo: 'alpha' })]);
    };
    const { code, out, dir, port } = await runCli(['pause', '--yes', '--repo', 'gamma', '--role', 'coordinator'], [{ paneKey: 'x:1', repo: 'alpha', behavior: pausedDone() }], withRepos({ seed }));
    expect(code).toBe(0);
    expect(out).not.toContain('nothing to pause');
    expect(port.sends).toEqual([]);
    const [run] = await readRuns(dir);
    expect(run?.scope).toHaveLength(2);
  });

  it('retries and waits only for the agents it selected: an unconfirmed agent outside the filters keeps its state and its exit code is ignored', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [
        agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', pauseStatus: 'unconfirmed', pauseReason: 'send-failed', messagePending: true }),
        agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta', pauseStatus: 'unconfirmed', pauseReason: 'send-failed', messagePending: true }),
      ]);
    };
    const agents: FakeAgent[] = [
      { paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() },
      { paneKey: 'b:1', repo: 'beta', behavior: repliesWithToken() },
    ];
    const { code, port, dir } = await runCli(['pause', '--yes', '--repo', 'alpha'], agents, withRepos({ seed }));
    expect(code).toBe(0);
    expect(sentPanes(port)).toEqual(['a:1']);
    const [run] = await readRuns(dir);
    expect(run?.agents.find((a) => a.paneKey === 'b:1')).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'send-failed' });

    const control = await runCli(['pause', '--yes', '--repo', 'beta'], [{ paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() }, { paneKey: 'b:1', repo: 'beta', behavior: working }], withRepos({ seed }));
    expect(control.code).toBe(1); // the same agent, once selected, decides the exit code
  });

  it('a wake-up re-pause still covers a confirmed agent outside the filters', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [
        agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', pauseBaseline: 'Stopped.\nORCA-PAUSED abcd1234' }),
        agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta', pauseBaseline: 'Stopped.\nORCA-PAUSED abcd1234' }),
      ]);
    };
    const agents: FakeAgent[] = [
      { paneKey: 'a:1', repo: 'alpha', behavior: () => ({ state: 'done', message: 'Stopped.\nORCA-PAUSED abcd1234' }) },
      { paneKey: 'b:1', repo: 'beta', behavior: wokenWorking },
    ];
    const { port } = await runCli(['pause', '--yes', '--repo', 'alpha'], agents, withRepos({ seed, ask: undefined }));
    expect(sentPanes(port)).toEqual(['b:1']);
  });

  it('records self only when it matches the filters', async () => {
    const agents: FakeAgent[] = [
      { paneKey: 's:1', repo: 'alpha', behavior: working },
      { paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() },
      { paneKey: 'b:1', repo: 'beta', behavior: repliesWithToken() },
    ];
    const matching = await runCli(['pause', '--yes', '--repo', 'alpha'], agents, withRepos({ env: { ORCA_PANE_KEY: 's:1' } }));
    expect((await readRuns(matching.dir))[0]?.agents.map((a) => a.paneKey)).toContain('s:1');

    const other = await runCli(['pause', '--yes', '--repo', 'beta'], agents, withRepos({ env: { ORCA_PANE_KEY: 's:1' } }));
    expect((await readRuns(other.dir))[0]?.agents.map((a) => a.paneKey)).not.toContain('s:1');

    const plain = await runCli(['pause', '--yes'], agents, withRepos({ env: { ORCA_PANE_KEY: 's:1' } }));
    expect((await readRuns(plain.dir))[0]?.agents.map((a) => a.paneKey)).toContain('s:1');
  });

  it('re-opens a matching abandoned agent that a filtered close left, and leaves a non-matching one', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [
        agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', resumeStatus: 'abandoned' }),
        agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta', resumeStatus: 'abandoned' }),
        agentRecord('g:1', { repoId: 'repo-gamma', repo: 'gamma' }),
      ]);
    };
    const agents: FakeAgent[] = [
      { paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() },
      { paneKey: 'b:1', repo: 'beta', behavior: repliesWithToken() },
      { paneKey: 'g:1', repo: 'gamma', behavior: pausedDone() },
    ];
    const { code, port, dir } = await runCli(['pause', '--yes', '--repo', 'alpha'], agents, withRepos({ seed }));
    expect(code).toBe(0);
    expect(sentPanes(port)).toEqual(['a:1']);
    const [run] = await readRuns(dir);
    expect(run?.agents.map((a) => a.resumeStatus)).toEqual(['pending', 'abandoned', 'pending']);
  });

  it('leaves a matching abandoned agent as it is when it cannot be located', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', resumeStatus: 'abandoned' }), agentRecord('a:2', { repoId: 'repo-alpha', repo: 'alpha' })]);
    };
    const { port, dir } = await runCli(['pause', '--yes', '--repo', 'alpha'], [{ paneKey: 'a:2', repo: 'alpha', behavior: pausedDone() }], withRepos({ seed }));
    expect(port.sends).toEqual([]);
    expect((await readRuns(dir))[0]?.agents.map((a) => a.resumeStatus)).toEqual(['abandoned', 'pending']);
  });

  it('does not list in the prompt an agent outside the filters that has an old pending message', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [
        agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', pauseStatus: 'unconfirmed', pauseReason: 'waiting-permission', messagePending: true }),
        agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta', pauseStatus: 'unconfirmed', pauseReason: 'still-working', messagePending: true }),
      ]);
    };
    const agents: FakeAgent[] = [
      { paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() },
      { paneKey: 'b:1', repo: 'beta', behavior: repliesWithToken() },
    ];
    const { err, questions, port } = await runCli(['pause', '--repo', 'alpha'], agents, withRepos({ seed, ask: ['y'] }));
    expect(questions).toHaveLength(1);
    expect(err).toContain('alpha/tree-a:1');
    expect(err).not.toContain('beta/tree-b:1');
    expect(sentPanes(port)).toEqual(['a:1']);
  });

  it('marks a matching earlier self gone when it cannot be located, instead of waiting for the timeout', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('s:old', { repoId: 'repo-alpha', repo: 'alpha', pauseStatus: 'unconfirmed', pauseReason: 'self' })]);
    };
    const clock = fakeClock();
    const { code, dir } = await runCli(['pause', '--yes', '--repo', 'alpha'], [{ paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() }], withRepos({ seed, clock, env: { ORCA_PANE_KEY: 'x:1' } }));
    expect((await readRuns(dir))[0]?.agents.find((a) => a.paneKey === 's:old')?.resumeStatus).toBe('gone');
    expect(code).toBe(1); // it was never confirmed, so it keeps the exit code at 1, as a gone agent does today
    expect(clock.slept).toBeLessThan(60_000);
  });

  it('leaves an earlier self that does not match the filters as it was', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('s:old', { repoId: 'repo-beta', repo: 'beta', pauseStatus: 'unconfirmed', pauseReason: 'self' })]);
    };
    const { code, dir } = await runCli(['pause', '--yes', '--repo', 'alpha'], [{ paneKey: 'a:1', repo: 'alpha', behavior: repliesWithToken() }], withRepos({ seed, env: { ORCA_PANE_KEY: 'x:1' } }));
    expect(code).toBe(0);
    expect((await readRuns(dir))[0]?.agents.find((a) => a.paneKey === 's:old')).toMatchObject({ pauseReason: 'self', resumeStatus: 'pending' });
  });

  it('exits 2 on a run written before filters, and a plain close still ends it', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1')]);
      const run = { ...(await store.findOpenRun())?.run } as Partial<Run>;
      delete run.scope;
      await store.save(run as Run);
    };
    const paused = await runCli(['pause', '--yes'], fleet(), withRepos({ seed }));
    expect(paused.code).toBe(2);
    expect(paused.err).toContain('older version');
    expect(paused.port.sends).toEqual([]);
    expect((await runCli(['resume', '--yes'], fleet(), withRepos({ seed }))).code).toBe(2);
    expect((await runCli(['close', '--repo', 'alpha'], fleet(), withRepos({ seed }))).code).toBe(2);
    const closed = await runCli(['close'], fleet(), withRepos({ seed }));
    expect(closed.code).toBe(0);
    expect(closed.port.listCalls).toBe(0);
  });
});

describe('resume with filters', () => {
  const seed = async (store: ReturnType<typeof createRecordStore>) => {
    await seedOpenRun(store, [
      agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', worktreeId: 'wt-a:1', worktree: 'main', worktreePath: '/work/main', role: 'worker', orchestrationRunIds: ['run_1'] }),
      agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta', role: 'session' }),
    ]);
  };
  const agents = (): FakeAgent[] => [
    { paneKey: 'a:1', repo: 'alpha', worktree: 'main', behavior: pausedDone() },
    { paneKey: 'b:1', repo: 'beta', behavior: pausedDone() },
  ];

  it('continues only the matching recorded agents, leaves the run open and exits by the selected agents', async () => {
    const { code, port, dir } = await runCli(['resume', '--yes', '--repo', 'alpha'], agents(), withRepos({ seed }));
    expect(sentPanes(port)).toEqual(['a:1']);
    expect(code).toBe(1); // the fake agent never answers CONTINUE, so the selected agent has no proof
    const [run] = await readRuns(dir);
    expect(run?.status).toBe('open');
    expect(run?.agents.find((a) => a.paneKey === 'b:1')?.resumeStatus).toBe('pending');
  });

  it('matches the role and run ids saved in the record', async () => {
    const byRole = await runCli(['resume', '--yes', '--role', 'session'], agents(), withRepos({ seed }));
    expect(sentPanes(byRole.port)).toEqual(['b:1']);
    const byRun = await runCli(['resume', '--yes', '--run', 'run_1'], agents(), withRepos({ seed }));
    expect(sentPanes(byRun.port)).toEqual(['a:1']);
  });

  it('names an agent whose worktree Orca no longer lists, through the record', async () => {
    const { port, code, out, dir } = await runCli(['resume', '--yes', '--worktree', '/work/main'], [{ paneKey: 'b:1', repo: 'beta', behavior: pausedDone() }], withRepos({ seed }));
    expect(code).toBe(0); // the matching agent has no terminal: it counts as gone, which is settled
    expect(port.sends).toEqual([]);
    expect(out).not.toContain('nothing to resume');
    expect((await readRuns(dir))[0]?.agents.map((a) => a.resumeStatus)).toEqual(['gone', 'pending']);
  });

  it('prints "nothing to resume" with the filters when none of the pending agents match, and keeps the run open', async () => {
    const { code, out, port, dir } = await runCli(['resume', '--yes', '--repo', 'gamma'], agents(), withRepos({ seed, configure: () => {} }));
    expect(code).toBe(0);
    expect(out).toContain('nothing to resume');
    expect(out).toContain('filters: --repo gamma');
    expect(port.sends).toEqual([]);
    expect((await readRuns(dir))[0]?.status).toBe('open');
  });

  it('with no open run and a mistyped value it prints "nothing to resume", exit 0, without listing', async () => {
    const { code, out, port } = await runCli(['resume', '--yes', '--repo', 'typo'], agents(), withRepos());
    expect(code).toBe(0);
    expect(out).toContain('nothing to resume');
    expect(port.listCalls).toBe(0);
  });

  it('never selects an abandoned agent', async () => {
    const abandonedSeed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [
        agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', resumeStatus: 'abandoned' }),
        agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta' }),
      ]);
    };
    const { out, port } = await runCli(['resume', '--yes', '--repo', 'alpha'], agents(), withRepos({ seed: abandonedSeed }));
    expect(out).toContain('nothing to resume');
    expect(port.sends).toEqual([]);
  });
});

describe('resolution on resume and close', () => {
  const seed = async (store: ReturnType<typeof createRecordStore>) => {
    await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' }), agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta' })]);
  };

  it('a live-only repo name resolves on close, together with the record', async () => {
    const { code, out } = await runCli(['close', '--repo', '/r/gamma'], [], withRepos({ seed }));
    expect(code).toBe(0);
    expect(out).toContain('nothing to close'); // gamma is known live and has no pending agent
  });

  it('a value that reaches two ids across the live listing and the record is ambiguous', async () => {
    const { code, err } = await runCli(['close', '--repo', 'alpha'], [], withRepos({ seed, configure: (p) => p.repos.push({ id: 'repo-other', path: '/r/other', displayName: 'alpha' }) }));
    expect(code).toBe(2);
    expect(err).toContain('ambiguous --repo "alpha"');
  });

  it('an unknown run id exits 2 on resume', async () => {
    const { code, err, port } = await runCli(['resume', '--yes', '--run', 'run_nope'], [], withRepos({ seed }));
    expect(code).toBe(2);
    expect(err).toContain('unknown --run "run_nope"');
    expect(port.sends).toEqual([]);
  });

  it('refreshes the repo id and worktree path of a located agent on resume', async () => {
    const { dir } = await runCli(['resume', '--yes', '--repo', 'alpha'], [{ paneKey: 'a:1', repo: 'alpha', worktree: 'moved', behavior: pausedDone() }], withRepos({ seed }));
    expect((await readRuns(dir))[0]?.agents[0]).toMatchObject({ repoId: 'repo-alpha', worktreePath: '/work/moved', worktreeId: 'wt-a:1' });
  });
});

describe('filters beside an open broadcast record', () => {
  const broadcastSeed = async (store: ReturnType<typeof createRecordStore>) => {
    await store.saveBroadcast({ id: 'b-1', token: 'abcd1234', text: 'hello', createdAt: '2026-01-01T00:00:00.000Z', status: 'open', targets: [] });
    await store.setCurrent('broadcast', 'b-1');
  };

  it('a filtered close that matches no pending target of a broadcast prints "nothing to close" and leaves it open', async () => {
    const { code, out, dir } = await runCli(['close', '--repo', 'alpha'], [], withRepos({ seed: broadcastSeed }));
    expect(code).toBe(0);
    expect(out).toContain('nothing to close');
    const record = JSON.parse(await readFile(join(dir, 'orca-broadcast', 'broadcasts', 'b-1.json'), 'utf8')) as { status: string };
    expect(record.status).toBe('open');
  });

  it('a plain close still closes the broadcast, and a filtered pause closes it as paused', async () => {
    const paused = await runCli(['pause', '--yes', '--repo', 'alpha'], fleet(), withRepos({ seed: broadcastSeed }));
    expect(paused.code).toBe(0);
    expect(paused.err).toContain('broadcast b-1 was closed by this pause');
    const closed = await runCli(['close'], [], withRepos({ seed: broadcastSeed }));
    expect(closed.out).toContain('closed broadcast b-1');
  });
});

describe('close with filters', () => {
  const seed = async (store: ReturnType<typeof createRecordStore>) => {
    await seedOpenRun(store, [
      agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' }),
      agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta' }),
    ]);
  };

  it('abandons only the matching agents and keeps the run open while others are pending; exit 0', async () => {
    const { code, port, dir } = await runCli(['close', '--repo', 'alpha'], [], withRepos({ seed }));
    expect(code).toBe(0);
    expect(port.sends).toEqual([]);
    const [run] = await readRuns(dir);
    expect(run?.status).toBe('open');
    expect(run?.agents.map((a) => a.resumeStatus)).toEqual(['abandoned', 'pending']);
  });

  it('closes the run once no agent is pending, and clears the pointer', async () => {
    const closeSeed = async (store: ReturnType<typeof createRecordStore>) => {
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' }), agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta', resumeStatus: 'resumed' })]);
    };
    const { dir } = await runCli(['close', '--repo', 'alpha'], [], withRepos({ seed: closeSeed }));
    expect((await readRuns(dir))[0]?.status).toBe('closed');
    expect(await readdir(join(dir, 'orca-broadcast'))).not.toContain('current');
  });

  it('matches the saved values without Orca: a failed listing falls back to the record', async () => {
    const { code, dir } = await runCli(['close', '--repo', 'repo-alpha'], [], withRepos({ seed, configure: (p) => (p.failListingsFrom = 1) }));
    expect(code).toBe(0);
    expect((await readRuns(dir))[0]?.agents.map((a) => a.resumeStatus)).toEqual(['abandoned', 'pending']);
  });

  it('prints "nothing to close" with the filters when no pending agent matches, and keeps the run open', async () => {
    const { code, out, dir } = await runCli(['close', '--repo', 'gamma'], [], withRepos({ seed }));
    expect(code).toBe(0);
    expect(out).toContain('nothing to close');
    expect(out).toContain('filters: --repo gamma');
    expect((await readRuns(dir))[0]?.status).toBe('open');
  });

  it('is never refused for a missing terminal or --yes', async () => {
    const { code } = await runCli(['close', '--repo', 'alpha'], [], withRepos({ seed, isTTY: false }));
    expect(code).toBe(0);
  });

  it('a plain close needs no port', async () => {
    const dir = await tempStateDir();
    const store = createRecordStore(dir);
    await seedOpenRun(store, [agentRecord('a:1')]);
    expect((await close(store)).outcome).toBe('done');
  });

  it('with no open run and a mistyped value it prints "nothing to close", exit 0, without listing', async () => {
    const { code, out, port } = await runCli(['close', '--repo', 'typo'], [], withRepos());
    expect(code).toBe(0);
    expect(out).toContain('nothing to close');
    expect(port.listCalls).toBe(0);
  });
});

