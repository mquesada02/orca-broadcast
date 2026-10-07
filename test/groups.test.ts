import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRecordStore } from '../src/store.js';
import type { Run } from '../src/types.js';
import { type FakeAgent, FakeOrca, pausedDone, repliesWithToken, seedOpenRun, agentRecord, working } from './helpers/fake-orca.js';
import { groupsFile, runCli, seedGroups, writeGroups, type RunCliOptions, type Seed } from './helpers/run-cli.js';

const REPOS = [
  { id: 'repo-alpha', path: '/r/alpha', displayName: 'alpha' },
  { id: 'repo-beta', path: '/r/beta', displayName: 'beta' },
];

const fleet = (): FakeAgent[] => [
  { paneKey: 'a:1', repo: 'alpha', worktree: 'main', behavior: repliesWithToken() },
  { paneKey: 'a:2', repo: 'alpha', worktree: 'feature', behavior: repliesWithToken() },
  { paneKey: 'b:1', repo: 'beta', worktree: 'main', behavior: repliesWithToken() },
];

const withRepos = (opts: RunCliOptions = {}): RunCliOptions => ({
  ...opts,
  configure: (port) => {
    port.repos = [...REPOS];
    port.workersAt = () => [{ paneKey: 'a:2' }];
    opts.configure?.(port);
  },
});

const readGroups = async (stateDir: string) => JSON.parse(await readFile(groupsFile(stateDir), 'utf8'));
const sentPanes = (port: FakeOrca) => [...new Set(port.sends.map((s) => s.handle.replace('term_', '')))].sort();
const json = (text: string) => JSON.parse(text);

describe('group add', () => {
  it('saves a group after every value resolves, and prints one line', async () => {
    const { code, out, dir, port } = await runCli(['group', 'add', 'web', '--repo', 'alpha', '--role', 'worker', '--state', 'done'], fleet(), withRepos());
    expect(code).toBe(0);
    expect(out).toBe('added group web\n');
    expect(await readGroups(dir)).toEqual({ version: 1, groups: { web: { repo: ['alpha'], role: ['worker'], state: ['done'] } } });
    expect(port.sends).toEqual([]);
  });

  it('leaves no temporary file after a write', async () => {
    const { dir } = await runCli(['group', 'add', 'web', '--repo', 'alpha'], fleet(), withRepos());
    expect(await readdir(dirname(groupsFile(dir)))).toEqual(['groups.json']);
  });

  it('refuses an existing name and keeps the file', async () => {
    const { code, err, dir } = await runCli(['group', 'add', 'web', '--repo', 'beta'], fleet(), withRepos({ seed: seedGroups({ web: { repo: ['alpha'] } }) }));
    expect(code).toBe(2);
    expect(err).toContain('group "web" exists: remove it first');
    expect((await readGroups(dir)).groups.web.repo).toEqual(['alpha']);
  });

  it.each([['Web'], ['1web'], ['we_b'], ['a'.repeat(41)]])('refuses the bad name %s', async (name) => {
    const { code, err } = await runCli(['group', 'add', name, '--repo', 'alpha'], fleet(), withRepos());
    expect(code).toBe(2);
    expect(err).toContain('invalid group name');
  });

  it('accepts the longest name', async () => {
    const { code } = await runCli(['group', 'add', `a${'b'.repeat(39)}`, '--role', 'worker'], fleet(), withRepos());
    expect(code).toBe(0);
  });

  it('refuses a group with no filter', async () => {
    const { code, err, dir } = await runCli(['group', 'add', 'web'], fleet(), withRepos());
    expect(code).toBe(2);
    expect(err).toContain('a group needs at least one filter');
    await expect(readFile(groupsFile(dir))).rejects.toThrow();
  });

  it('refuses an unknown and an ambiguous value, naming it', async () => {
    const unknown = await runCli(['group', 'add', 'web', '--repo', 'nope'], fleet(), withRepos());
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown --repo "nope"');
    const ambiguous = await runCli(['group', 'add', 'web', '--worktree', 'main'], fleet(), withRepos());
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain('ambiguous --worktree "main"');
  });

  it('refuses a bad --state and names the allowed values', async () => {
    const { code, err } = await runCli(['group', 'add', 'web', '--state', 'bogus'], fleet(), withRepos());
    expect(code).toBe(2);
    expect(err).toContain('working, done');
  });

  it('accepts a state-only group without listing Orca', async () => {
    const { code, port, dir } = await runCli(['group', 'add', 'idle', '--state', 'done'], fleet(), withRepos());
    expect(code).toBe(0);
    expect(port.listCalls).toBe(0);
    expect((await readGroups(dir)).groups.idle).toEqual({ state: ['done'] });
  });

  it('saves a worktree path absolute and a worktree name as typed', async () => {
    const byPath = await runCli(['group', 'add', 'p', '--worktree', './feature'], fleet(), withRepos({ cwd: '/work' }));
    expect(byPath.code).toBe(0);
    expect((await readGroups(byPath.dir)).groups.p.worktree).toEqual(['/work/feature']);
    const byName = await runCli(['group', 'add', 'n', '--repo', 'beta', '--worktree', 'main'], fleet(), withRepos());
    expect((await readGroups(byName.dir)).groups.n.worktree).toEqual(['main']);
  });

  it('reports the group in --json', async () => {
    const { code, out } = await runCli(['group', 'add', 'web', '--repo', 'alpha', '--json'], fleet(), withRepos());
    expect(code).toBe(0);
    expect(json(out)).toEqual({ command: 'group add', outcome: 'done', exitCode: 0, error: null, groups: { web: { filters: { repo: ['alpha'] } } } });
  });
});

describe('group list, show and remove', () => {
  const seeded = withRepos({ seed: seedGroups({ web: { repo: ['alpha'], role: ['worker'] }, done: { state: ['done'] } }) });

  it('list prints one line per group, or "no groups"', async () => {
    const some = await runCli(['group', 'list'], fleet(), seeded);
    expect(some.out).toBe('web: --repo alpha --role worker\ndone: --state done\n');
    const none = await runCli(['group', 'list'], fleet(), withRepos());
    expect(none.code).toBe(0);
    expect(none.out).toBe('no groups\n');
    expect(json((await runCli(['group', 'list', '--json'], fleet(), withRepos())).out).groups).toEqual({});
  });

  it('list and remove never list Orca', async () => {
    const list = await runCli(['group', 'list'], fleet(), seeded);
    expect(list.port.listCalls).toBe(0);
    const remove = await runCli(['group', 'remove', 'web'], fleet(), seeded);
    expect(remove.port.listCalls).toBe(0);
  });

  it('show prints the filters and the agents that match now, and sends nothing', async () => {
    const { code, out, port } = await runCli(['group', 'show', 'web'], fleet(), seeded);
    expect(code).toBe(0);
    expect(out).toBe('group web: --repo alpha --role worker\nalpha/feature  worker  working\n');
    expect(port.sends).toEqual([]);
  });

  it('show matches the state kind on live Orca state', async () => {
    const agents: FakeAgent[] = [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'main', behavior: pausedDone() },
      { paneKey: 'a:2', repo: 'alpha', worktree: 'feature', behavior: working },
    ];
    const { out } = await runCli(['group', 'show', 'done'], agents, withRepos({ seed: seedGroups({ done: { repo: ['alpha'], state: ['done'] } }) }));
    expect(out).toBe('group done: --repo alpha --state done\nalpha/main  session  done\n');
  });

  it('show says so when nobody matches, in --json too', async () => {
    const opts = withRepos({ seed: seedGroups({ beta: { repo: ['beta'], role: ['coordinator'] } }) });
    expect((await runCli(['group', 'show', 'beta'], fleet(), opts)).out).toContain('no agents match');
    const { out } = await runCli(['group', 'show', 'beta', '--json'], fleet(), opts);
    expect(json(out)).toMatchObject({ command: 'group show', outcome: 'nothing-to-do', exitCode: 0, groups: { beta: { filters: { repo: ['beta'], role: ['coordinator'] }, agents: [] } } });
  });

  it('show exits 2 naming the value when a stored value no longer resolves', async () => {
    const { code, err } = await runCli(['group', 'show', 'gone'], fleet(), withRepos({ seed: seedGroups({ gone: { repo: ['vanished'] } }) }));
    expect(code).toBe(2);
    expect(err).toContain('group gone: unknown --repo "vanished"');
  });

  it('remove deletes one group', async () => {
    const { code, out, dir } = await runCli(['group', 'remove', 'web'], fleet(), seeded);
    expect(code).toBe(0);
    expect(out).toBe('removed group web\n');
    expect((await readGroups(dir)).groups).toEqual({ done: { state: ['done'] } });
  });

  it.each([['show'], ['remove']])('%s with an unknown name exits 2 listing the known names', async (sub) => {
    const { code, err } = await runCli(['group', sub, 'nope'], fleet(), seeded);
    expect(code).toBe(2);
    expect(err).toContain('unknown group "nope"; known: web, done');
  });

  it('says there are none when no group is saved, and does not treat "constructor" as a group', async () => {
    const { code, err } = await runCli(['group', 'show', 'constructor'], fleet(), withRepos());
    expect(code).toBe(2);
    expect(err).toContain('no groups are saved');
  });

  it('takes no run lock', async () => {
    const lock: Seed = async (_store, dir) => {
      await seedGroups({ web: { repo: ['alpha'] } })(_store, dir);
      await mkdir(join(dir, 'orca-broadcast'), { recursive: true });
      await writeFile(join(dir, 'orca-broadcast', 'lock'), `${process.pid}\n`);
    };
    const { code, out } = await runCli(['group', 'list'], fleet(), withRepos({ seed: lock }));
    expect(code).toBe(0);
    expect(out).toContain('web: --repo alpha');
  });
});

describe('group usage', () => {
  it.each([
    [['group'], 'missing group subcommand'],
    [['group', 'frob'], 'unknown group subcommand "frob"'],
    [['group', 'add', '--repo', 'alpha'], 'group add needs a group name'],
    [['group', 'list', 'extra'], 'group list takes no argument'],
    [['group', 'show', 'a', 'b'], 'group show takes one group name'],
    [['group', 'list', '--yes'], '--yes does not apply to group list'],
    [['group', 'add', 'x', '--repo', 'alpha', '--timeout', '1m'], '--timeout does not apply to group add'],
    [['group', 'show', 'x', '--group', 'y'], '--group does not apply to group show'],
    [['group', 'remove', 'x', '--repo', 'alpha'], '--repo does not apply to group remove'],
  ])('%j exits 2: %s', async (argv, message) => {
    const { code, err } = await runCli(argv, fleet(), withRepos());
    expect(code).toBe(2);
    expect(err).toContain(message);
  });

  it('answers a group error in --json with the group command and no run', async () => {
    const { code, out } = await runCli(['group', 'show', 'nope', '--json'], fleet(), withRepos());
    expect(code).toBe(2);
    expect(json(out)).toMatchObject({ command: 'group show', outcome: 'error', exitCode: 2, groups: null });
    const bare = await runCli(['group', '--json'], fleet(), withRepos());
    expect(json(bare.out)).toMatchObject({ command: 'group', outcome: 'error', exitCode: 2, groups: null });
  });

  it('keeps the existing messages of the send commands', async () => {
    const state = await runCli(['pause', '--yes', '--state', 'done'], fleet(), withRepos());
    expect(state.err).toContain('--state applies only to broadcast');
    const group = await runCli(['broadcast', 'hi', '--yes', '--group', 'web'], fleet(), withRepos());
    expect(group.err).toContain('--group applies only to pause, resume and close');
  });
});

describe('groups.json', () => {
  it('a missing file means no groups, so --group names none', async () => {
    const { code, err } = await runCli(['pause', '--yes', '--group', 'web'], fleet(), withRepos());
    expect(code).toBe(2);
    expect(err).toContain('unknown group "web"; no groups are saved');
  });

  it.each([
    ['bad JSON', '{nope'],
    ['a wrong version', { version: 2, groups: {} }],
    ['an unknown top-level key', { version: 1, groups: {}, extra: 1 }],
    ['a bad name', { version: 1, groups: { Web: { repo: ['a'] } } }],
    ['an unknown kind', { version: 1, groups: { web: { colour: ['a'] } } }],
    ['a non-list kind', { version: 1, groups: { web: { repo: 'a' } } }],
    ['a bad role', { version: 1, groups: { web: { role: ['boss'] } } }],
    ['a bad state', { version: 1, groups: { web: { state: ['paused'] } } }],
    ['an empty group', { version: 1, groups: { web: { repo: [] } } }],
  ])('%s exits 2 naming the file', async (_label, content) => {
    const seed: Seed = (_store, dir) => writeGroups(dir, content);
    for (const argv of [['group', 'list'], ['pause', '--yes', '--group', 'web']]) {
      const { code, err, dir, port } = await runCli(argv, fleet(), withRepos({ seed }));
      expect(code).toBe(2);
      expect(err).toContain(`invalid groups file ${groupsFile(dir)}`);
      expect(port.sends).toEqual([]);
    }
  });

  it('a broken file does not affect commands that use no group', async () => {
    const { code } = await runCli(['pause', '--yes', '--repo', 'beta'], fleet(), withRepos({ seed: (_s, dir) => writeGroups(dir, '{nope') }));
    expect(code).toBe(0);
  });

  it('the file error wins over a held lock', async () => {
    const seed: Seed = async (_store, dir) => {
      await writeGroups(dir, '{nope');
      await mkdir(join(dir, 'orca-broadcast'), { recursive: true });
      await writeFile(join(dir, 'orca-broadcast', 'lock'), `${process.pid}\n`);
    };
    const { code, err } = await runCli(['pause', '--yes', '--group', 'web'], fleet(), withRepos({ seed }));
    expect(code).toBe(2);
    expect(err).toContain('invalid groups file');
  });
});

describe('--group on pause, resume and close', () => {
  const web = seedGroups({ web: { repo: ['alpha'] }, workers: { role: ['worker'] }, frontend: { repo: ['alpha', 'beta'], role: ['worker'], state: ['working'] }, onlystate: { state: ['working'] } });

  it('pause --group acts on the group only', async () => {
    const { code, port } = await runCli(['pause', '--yes', '--group', 'web'], fleet(), withRepos({ seed: web }));
    expect(code).toBe(0);
    expect(sentPanes(port)).toEqual(['a:1', 'a:2']);
  });

  it('a second --group is a usage error, whatever else is wrong', async () => {
    const { code, err, port } = await runCli(['pause', '--group', 'web', '--group', 'workers'], fleet(), withRepos({ seed: web }));
    expect(code).toBe(2);
    expect(err).toContain('use at most one --group');
    expect(port.sends).toEqual([]);
  });

  it('an unknown name exits 2 listing the known names', async () => {
    const { code, err } = await runCli(['pause', '--yes', '--group', 'nope'], fleet(), withRepos({ seed: web }));
    expect(code).toBe(2);
    expect(err).toContain('unknown group "nope"; known: web, workers, frontend, onlystate');
  });

  it('without --yes or a terminal the refusal to send wins over an unknown group', async () => {
    const { code, err } = await runCli(['pause', '--group', 'nope'], fleet(), withRepos({ seed: web }));
    expect(code).toBe(2);
    expect(err).toContain('refusing to send without an interactive terminal');
  });

  it('ad-hoc filters narrow the group: kinds ANDed, the same kind intersected on resolved ids', async () => {
    const andKinds = await runCli(['pause', '--yes', '--group', 'web', '--role', 'worker'], fleet(), withRepos({ seed: web }));
    expect(sentPanes(andKinds.port)).toEqual(['a:2']);
    // The group names repo "alpha"; the ad-hoc value is the same repo by path, so the intersection is alpha, not nothing.
    const sameRepo = await runCli(['pause', '--yes', '--group', 'web', '--repo', '/r/alpha'], fleet(), withRepos({ seed: web }));
    expect(sentPanes(sameRepo.port)).toEqual(['a:1', 'a:2']);
    const intersect = await runCli(['pause', '--yes', '--group', 'frontend', '--repo', 'beta'], fleet(), withRepos({ seed: web }));
    expect(sentPanes(intersect.port)).toEqual([]);
  });

  it('an empty intersection prints "nothing to pause" with the group and the ad-hoc filters, exit 0, nothing written', async () => {
    const { code, out, port, dir } = await runCli(['pause', '--yes', '--group', 'web', '--repo', 'beta'], fleet(), withRepos({ seed: web }));
    expect(code).toBe(0);
    expect(out).toContain('nothing to pause');
    expect(out).toContain('filters: --group web --repo beta');
    expect(port.sends).toEqual([]);
    expect(await readdir(join(dir, 'orca-broadcast')).catch(() => [])).not.toContain('pauses');
  });

  it('an empty intersection on an open run appends a set that sweeps nobody', async () => {
    const seed: Seed = async (store, dir) => {
      await web(store, dir);
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' })]);
    };
    const { code, dir } = await runCli(['pause', '--yes', '--group', 'web', '--repo', 'beta'], fleet(), withRepos({ seed }));
    expect(code).toBe(0);
    const run = (await createRecordStore(join(dir, 'orca-broadcast')).findOpenRun())?.run as Run;
    expect(run.scope).toHaveLength(2);
    expect(run.scope[1]).toMatchObject({ repoIds: [], group: 'web' });
  });

  it('a value that no longer resolves exits 2 naming group and value', async () => {
    const gone = seedGroups({ gone: { repo: ['vanished'] }, stale: { run: ['run_old'] } });
    const repo = await runCli(['pause', '--yes', '--group', 'gone'], fleet(), withRepos({ seed: gone }));
    expect(repo.code).toBe(2);
    expect(repo.err).toContain('group gone: unknown --repo "vanished"');
    const run = await runCli(['pause', '--yes', '--group', 'stale'], fleet(), withRepos({ seed: gone }));
    expect(run.code).toBe(2);
    expect(run.err).toContain('group stale: unknown --run "run_old"');
    expect(repo.port.sends).toEqual([]);
  });

  it('skips the state kind with one stderr line, in text and in --json, and keeps stdout clean', async () => {
    const line = 'orca-broadcast: group frontend: state filter skipped (pause does not use it)\n';
    const text = await runCli(['pause', '--yes', '--group', 'frontend'], fleet(), withRepos({ seed: web }));
    expect(text.err).toBe(line);
    expect(sentPanes(text.port)).toEqual(['a:2']);
    const asJson = await runCli(['pause', '--yes', '--group', 'frontend', '--json'], fleet(), withRepos({ seed: web }));
    expect(asJson.err).toBe(line);
    expect(json(asJson.out)).toMatchObject({ command: 'pause', exitCode: 0 });
  });

  it('prints the skipped line before "nothing to pause", and also when the command then fails', async () => {
    const nothing = await runCli(['pause', '--yes', '--group', 'frontend', '--role', 'coordinator'], fleet(), withRepos({ seed: web }));
    expect(nothing.code).toBe(0);
    expect(nothing.err).toContain('state filter skipped');
    expect(nothing.out).toContain('nothing to pause');
    const fails = await runCli(['pause', '--yes', '--group', 'frontend', '--repo', 'nope'], fleet(), withRepos({ seed: web }));
    expect(fails.code).toBe(2);
    expect(fails.err).toContain('state filter skipped');
  });

  it.each([['pause', ['--yes']], ['resume', ['--yes']], ['close', []]])('a state-only group is refused by %s whatever ad-hoc filters are given', async (command, extra) => {
    for (const filters of [[], ['--repo', 'alpha']]) {
      const { code, err, port } = await runCli([command as string, ...extra, '--group', 'onlystate', ...filters], fleet(), withRepos({ seed: web }));
      expect(code).toBe(2);
      expect(err).toContain(`Group onlystate only filters by state, which ${command} does not use.`);
      expect(port.sends).toEqual([]);
    }
  });

  it('pause copies the resolved group into the run, and editing the file changes nothing until the next pause', async () => {
    const first = await runCli(['pause', '--yes', '--group', 'web'], fleet(), withRepos({ seed: web }));
    expect(first.code).toBe(0);
    const open = async () => (await createRecordStore(join(first.dir, 'orca-broadcast')).findOpenRun())?.run as Run;
    const stored = await open();
    expect(stored.scope).toHaveLength(1);
    expect(stored.scope[0]).toMatchObject({ group: 'web', repoIds: ['repo-alpha'], typed: { repo: ['alpha'] } });

    await writeGroups(first.dir, { version: 1, groups: { web: { repo: ['beta'] } } });
    expect((await open()).scope).toEqual(stored.scope);

    // resume --group reads the edited file: "web" is now beta, which matches none of the paused agents.
    const resumed = await runCli(['resume', '--yes', '--group', 'web'], fleet(), withRepos({ env: { XDG_STATE_HOME: first.dir, XDG_CONFIG_HOME: join(dirname(first.dir), 'config') } }));
    expect(resumed.out).toContain('nothing to resume');
    expect(resumed.out).toContain('filters: --group web');
    expect(resumed.port.sends).toEqual([]);
  });

  it('resume and close narrow the recorded agents by the group', async () => {
    const seed: Seed = async (store, dir) => {
      await web(store, dir);
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' }), agentRecord('b:1', { repoId: 'repo-beta', repo: 'beta' })]);
    };
    const closed = await runCli(['close', '--group', 'web'], fleet(), withRepos({ seed }));
    expect(closed.code).toBe(0);
    const run = (await createRecordStore(join(closed.dir, 'orca-broadcast')).findOpenRun())?.run as Run;
    expect(run.agents.map((a) => [a.paneKey, a.resumeStatus])).toEqual([['a:1', 'abandoned'], ['b:1', 'pending']]);

    const resumed = await runCli(['resume', '--yes', '--group', 'web'], fleet(), withRepos({ seed }));
    expect(sentPanes(resumed.port)).toEqual(['a:1']);
  });

  it('a stale run value exits 2 on resume and close too, naming group and value', async () => {
    const seed: Seed = async (store, dir) => {
      await seedGroups({ stale: { run: ['run_old'] } })(store, dir);
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' })]);
    };
    for (const argv of [['resume', '--yes', '--group', 'stale'], ['close', '--group', 'stale']]) {
      const { code, err } = await runCli(argv, fleet(), withRepos({ seed }));
      expect(code).toBe(2);
      expect(err).toContain('group stale: unknown --run "run_old"');
    }
  });

  it('a group value that became ambiguous exits 2 naming group and value', async () => {
    const { code, err } = await runCli(['pause', '--yes', '--group', 'amb'], fleet(), withRepos({ seed: seedGroups({ amb: { worktree: ['main'] } }) }));
    expect(code).toBe(2);
    expect(err).toContain('group amb: ambiguous --worktree "main"');
  });

  it('a held lock does not hide the state-only refusal', async () => {
    const seed: Seed = async (store, dir) => {
      await seedGroups({ onlystate: { state: ['working'] } })(store, dir);
      await mkdir(join(dir, 'orca-broadcast'), { recursive: true });
      await writeFile(join(dir, 'orca-broadcast', 'lock'), `${process.pid}\n`);
    };
    const { code, err } = await runCli(['pause', '--yes', '--group', 'onlystate'], fleet(), withRepos({ seed }));
    expect(code).toBe(2);
    expect(err).toContain('only filters by state');
  });

  it('close accepts a run id that only the open run recorded', async () => {
    const seed: Seed = async (store, dir) => {
      await seedGroups({ old: { run: ['run_recorded'] } })(store, dir);
      await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha', orchestrationRunIds: ['run_recorded'] })]);
    };
    const { code, err } = await runCli(['close', '--group', 'old'], fleet(), withRepos({ seed }));
    expect(code).toBe(0);
    expect(err).toBe('');
  });
});
