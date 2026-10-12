import { describe, expect, it } from 'vitest';
import type { RecordStore } from '../src/store.js';
import type { BroadcastRecord, BroadcastTarget } from '../src/types.js';
import { agentRecord, broadcastTarget, fakeClock, openBroadcastRecord, seedOpenRun, type Behavior, type FakeAgent, type FakeOrca } from './helpers/fake-orca.js';
import { hasPointer, readBroadcasts as readRecords, statusOf as status } from './helpers/records.js';
import { runCli, seedGroups, type RunCliOptions, type Seed } from './helpers/run-cli.js';

const TOKEN = 'abcd1234';
const ACK = `ORCA-ACK ${TOKEN}`;
const newToken = () => TOKEN;

const REPOS = [
  { id: 'repo-alpha', path: '/r/alpha', displayName: 'alpha' },
  { id: 'repo-beta', path: '/r/beta', displayName: 'beta' },
  { id: 'repo-gamma', path: '/r/gamma', displayName: 'gamma' },
];

const acksWhenSent: Behavior = ({ received }) => (received.length === 0 ? { state: 'done', message: 'Earlier reply.' } : { state: 'done', message: `Done.\n${ACK}` });
const silent = (state = 'working'): Behavior => () => ({ state, message: state === 'done' ? 'Earlier reply.' : null });

const fleet = (): FakeAgent[] => [
  { paneKey: 'a:1', repo: 'alpha', worktree: 'main', behavior: acksWhenSent },
  { paneKey: 'a:2', repo: 'alpha', worktree: 'feature', behavior: acksWhenSent },
  { paneKey: 'b:1', repo: 'beta', worktree: 'main', behavior: acksWhenSent },
  { paneKey: 'g:1', repo: 'gamma', worktree: 'main', behavior: acksWhenSent },
];

const withRepos = (opts: RunCliOptions = {}): RunCliOptions => ({
  newToken,
  storeOptions: { pid: 4242, readStartTime: () => '77' },
  ...opts,
  configure: (port: FakeOrca) => {
    port.repos = [...REPOS];
    opts.configure?.(port);
  },
});

const sentPanes = (port: FakeOrca) => [...new Set(port.sends.map((s) => s.handle.replace('term_', '')))].sort();
const send = (extra: string[], agents: FakeAgent[] = fleet(), opts: RunCliOptions = {}) => runCli(['broadcast', 'hello', '--yes', '--timeout', '10s', ...extra], agents, withRepos(opts));


describe('broadcast filters: a first broadcast', () => {
  it.each<[string, string[], string[]]>([
    ['a repo name', ['--repo', 'alpha'], ['a:1', 'a:2']],
    ['an id', ['--repo', 'repo-beta'], ['b:1']],
    ['two repos (ORed)', ['--repo', 'alpha', '--repo', 'beta'], ['a:1', 'a:2', 'b:1']],
    ['a worktree name scoped by repo', ['--repo', 'alpha', '--worktree', 'feature'], ['a:2']],
    ['a worktree path', ['--worktree', '/work/feature'], ['a:2']],
  ])('--%s narrows the targets', async (_name, flags, panes) => {
    const { code, port, dir } = await send(flags);
    expect(code).toBe(0);
    expect(sentPanes(port)).toEqual(panes);
    expect((await readRecords(dir))[0]?.targets.map((t) => t.paneKey).sort()).toEqual(panes);
  });

  it('ANDs kinds: --repo with --role, and --run', async () => {
    const configure = (p: FakeOrca) => (p.workersAt = () => [{ paneKey: 'a:2', runId: 'run_9' }, { paneKey: 'g:1', runId: 'run_9' }]);
    const role = await send(['--repo', 'alpha', '--repo', 'beta', '--role', 'worker'], fleet(), { configure });
    expect(sentPanes(role.port)).toEqual(['a:2']);
    const byRun = await send(['--run', 'run_9'], fleet(), { configure });
    expect(sentPanes(byRun.port)).toEqual(['a:2', 'g:1']);
  });

  it('--state selects by the live state: done, working, or both', async () => {
    const agents = (): FakeAgent[] => [
      { paneKey: 'a:1', repo: 'alpha', behavior: silent('done') },
      { paneKey: 'a:2', repo: 'alpha', behavior: silent('working') },
    ];
    const done = await send(['--state', 'done'], agents());
    expect(sentPanes(done.port)).toEqual(['a:1']);
    const working = await send(['--state', 'working'], agents());
    expect(sentPanes(working.port)).toEqual(['a:2']);
    const both = await send(['--state', 'working', '--state', 'done'], agents());
    expect(sentPanes(both.port)).toEqual(['a:1', 'a:2']);
  });

  it('never targets a waiting agent, whatever --state says', async () => {
    const { port, out } = await send(['--state', 'working'], [{ paneKey: 'w:1', behavior: () => ({ state: 'waiting', message: null }) }]);
    expect(port.sends).toEqual([]);
    expect(out).toContain('nothing to broadcast');
  });

  it('prints "nothing to broadcast" and the filters, exit 0, writes nothing, when the filters match nobody', async () => {
    const { code, out, port, dir } = await send(['--repo', 'alpha', '--role', 'coordinator']);
    expect(code).toBe(0);
    expect(out).toBe('nothing to broadcast\nfilters: --repo alpha --role coordinator\n');
    expect(port.sends).toEqual([]);
    expect(await readRecords(dir)).toEqual([]);
  });

  it('shows no filters line when none was given', async () => {
    const { out } = await send([], []);
    expect(out).toBe('nothing to broadcast\n');
  });

  it.each<[string[], string]>([
    [['--repo', 'nope'], 'unknown --repo "nope"'],
    [['--run', 'run_404'], 'unknown --run "run_404"'],
  ])('refuses %j with exit 2 and writes nothing', async (flags, message) => {
    const { code, err, port, dir } = await send(flags);
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(port.sends).toEqual([]);
    expect(await readRecords(dir)).toEqual([]);
  });

  it('--state may be given more than once, and a bad value is a usage error', async () => {
    const { code, err } = await send(['--state', 'idle']);
    expect(code).toBe(2);
    expect(err).toContain('invalid --state "idle"');
  });
});

describe('broadcast filters: groups', () => {
  const groups = seedGroups({ web: { repo: ['alpha'] }, finished: { state: ['done'] }, mix: { repo: ['alpha'], state: ['done'] } });
  const agents = (): FakeAgent[] => [
    { paneKey: 'a:1', repo: 'alpha', behavior: silent('done') },
    { paneKey: 'a:2', repo: 'alpha', behavior: silent('working') },
    { paneKey: 'b:1', repo: 'beta', behavior: silent('done') },
  ];

  it('--group selects what the group names', async () => {
    const { port } = await send(['--group', 'web'], agents(), { seed: groups });
    expect(sentPanes(port)).toEqual(['a:1', 'a:2']);
  });

  it("applies the group's state kind on broadcast, and a state-only group works", async () => {
    const mix = await send(['--group', 'mix'], agents(), { seed: groups });
    expect(sentPanes(mix.port)).toEqual(['a:1']);
    expect(mix.err).not.toContain('state filter skipped');
    const only = await send(['--group', 'finished'], agents(), { seed: groups });
    expect(sentPanes(only.port)).toEqual(['a:1', 'b:1']);
  });

  it('narrows a group with ad-hoc filters, the same kind giving the intersection', async () => {
    const narrowed = await send(['--group', 'web', '--repo', 'beta'], agents(), { seed: groups });
    expect(narrowed.out).toBe('nothing to broadcast\nfilters: --group web --repo beta\n');
    const states = await send(['--group', 'finished', '--state', 'working'], agents(), { seed: groups });
    expect(states.out).toContain('nothing to broadcast');
    expect(states.out).toContain('--group finished --state working');
  });

  it('still refuses a state-only group on pause, resume and close', async () => {
    for (const command of ['pause', 'resume', 'close']) {
      const { code, err } = await runCli([command, '--group', 'finished', ...(command === 'close' ? [] : ['--yes'])], agents(), withRepos({ seed: groups }));
      expect(code, command).toBe(2);
      expect(err, command).toContain('only filters by state');
    }
  });
  it('repeated --group sends to the union, applying the state kind of every group', async () => {
    const seed = seedGroups({ working: { repo: ['alpha'], state: ['working'] }, finished: { repo: ['beta'], state: ['done'] } });
    const { port } = await send(['--group', 'working', '--group', 'finished'], agents(), { seed });
    expect(sentPanes(port)).toEqual(['a:2', 'b:1']);
  });

  it('an ad-hoc filter narrows a union of groups on broadcast', async () => {
    const seed = seedGroups({ web: { repo: ['alpha'] }, finished: { state: ['done'] } });
    const { port } = await send(['--group', 'web', '--group', 'finished', '--repo', 'beta'], agents(), { seed });
    expect(sentPanes(port)).toEqual(['b:1']);
  });
});

const target = (paneKey: string, repo: string, extra: Partial<BroadcastTarget> = {}) =>
  broadcastTarget(paneKey, { repo, repoId: `repo-${repo}`, baseline: 'Earlier reply.', ...extra });

const seed =
  (targets: BroadcastTarget[], extra: Partial<BroadcastRecord> = {}): Seed =>
  async (store: RecordStore) => {
    const record = openBroadcastRecord(targets, extra);
    await store.saveBroadcast(record);
    await store.setCurrent('broadcast', record.id);
  };

const TARGETS = () => [target('a:1', 'alpha'), target('a:2', 'alpha'), target('b:1', 'beta'), target('g:1', 'gamma', { status: 'gone', reason: 'terminal-closed' })];

describe('broadcast filters: a re-run', () => {
  const rerun = (extra: string[], agents: FakeAgent[] = fleet(), opts: RunCliOptions = {}) => runCli(['broadcast', '--yes', '--timeout', '10s', ...extra], agents, withRepos(opts));
  const recordOf = async (dir: string) => (await readRecords(dir))[0] as BroadcastRecord;
  const ackless: Behavior = () => ({ state: 'done', message: 'No ack line.' });

  it('narrows the scope to the matching targets; the others keep their status and are not waited on', async () => {
    const { code, dir, out } = await rerun(['--repo', 'alpha'], [
      { paneKey: 'a:1', repo: 'alpha', behavior: () => ({ state: 'done', message: `Done.\n${ACK}` }) },
      { paneKey: 'a:2', repo: 'alpha', behavior: () => ({ state: 'done', message: `Done.\n${ACK}` }) },
      { paneKey: 'b:1', repo: 'beta', behavior: () => ({ state: 'done', message: `Done.\n${ACK}` }) },
    ], { seed: seed(TARGETS()) });
    expect(code).toBe(0);
    const record = await recordOf(dir);
    expect(status(record)).toEqual({ 'a:1': 'acked', 'a:2': 'acked', 'b:1': 'pending', 'g:1': 'gone' });
    expect(record.targets[2]?.reason).toBe('still-working'); // the saved reason: never polled
    expect(record.status).toBe('open');
    expect(out).toContain('beta'); // out-of-scope rows are shown
  });

  it('counts a gone target in scope as not acked (exit 1), and closes the record when nothing is pending', async () => {
    const { code, dir } = await rerun(['--repo', 'gamma'], fleet(), { seed: seed([target('g:1', 'gamma', { status: 'gone', reason: 'terminal-closed' })]) });
    expect(code).toBe(1);
    expect((await recordOf(dir)).status).toBe('closed');
  });

  it('matches the identity saved in the record, also for a worktree Orca no longer has', async () => {
    const targets = [target('a:1', 'alpha', { worktreeId: 'wt-old', worktreePath: '/work/old', worktree: 'old' }), target('b:1', 'beta')];
    const { code, port, dir } = await rerun(['--worktree', '/work/old'], [{ paneKey: 'a:1', repo: 'alpha', behavior: () => ({ state: 'done', message: `Done.\n${ACK}` }) }, { paneKey: 'b:1', repo: 'beta', behavior: ackless }], { seed: seed(targets) });
    expect(code).toBe(0);
    expect(port.sends).toEqual([]);
    expect(status(await recordOf(dir))).toEqual({ 'a:1': 'acked', 'b:1': 'pending' });
  });

  it('matches --state against the live state at the start, and a gone target never matches it', async () => {
    const targets = [target('a:1', 'alpha'), target('a:2', 'alpha'), target('g:1', 'gamma', { status: 'gone', reason: 'terminal-closed' })];
    const { code, dir } = await rerun(['--state', 'done'], [
      { paneKey: 'a:1', repo: 'alpha', behavior: () => ({ state: 'done', message: `Done.\n${ACK}` }) },
      { paneKey: 'a:2', repo: 'alpha', behavior: silent('working') },
    ], { seed: seed(targets) });
    expect(code).toBe(0); // only a:1 is in scope: a:2 is working, g:1 is gone and never matches
    expect(status(await recordOf(dir))).toEqual({ 'a:1': 'acked', 'a:2': 'pending', 'g:1': 'gone' });
  });

  it('never has an abandoned target in scope: shown in the table, not in the exit code', async () => {
    const targets = [target('a:1', 'alpha'), target('a:2', 'alpha', { status: 'abandoned', reason: 'closed' })];
    const { code, out } = await rerun(['--repo', 'alpha'], [{ paneKey: 'a:1', repo: 'alpha', behavior: () => ({ state: 'done', message: `Done.\n${ACK}` }) }], { seed: seed(targets) });
    expect(code).toBe(0);
    expect(out).toContain('abandoned');
  });

  it('prints "nothing to broadcast" and the filters when the filters leave nothing in scope, leaving the targets as they were', async () => {
    const targets = [...TARGETS().slice(0, 3), target('s:9', 'gamma', { messagePending: true, reason: 'send-failed' }), TARGETS()[3] as BroadcastTarget];
    const { code, out, port, dir } = await rerun(['--repo', 'gamma', '--role', 'worker'], fleet(), { seed: seed(targets, { pid: 1, startTime: '5' }) });
    expect(code).toBe(0);
    expect(out).toBe('nothing to broadcast\nfilters: --repo gamma --role worker\n');
    expect(port.sends).toEqual([]);
    const record = await recordOf(dir);
    expect(status(record)).toEqual({ 'a:1': 'pending', 'a:2': 'pending', 'b:1': 'pending', 's:9': 'pending', 'g:1': 'gone' });
    expect(record.targets[3]?.reason).toBe('send-failed'); // the final pid-clearing save does not persist a clearing
    expect(record).not.toHaveProperty('pid');
    expect(record.status).toBe('open');
  });

  it('leaves a settled but open record open when the filters match nothing', async () => {
    const { dir } = await rerun(['--repo', 'beta'], fleet(), { seed: seed([target('a:1', 'alpha', { status: 'acked', reason: null })]) });
    expect((await recordOf(dir)).status).toBe('open');
    expect(await hasPointer(dir)).toBe(true);
  });

  it('refuses an unknown filter value with exit 2, the targets unchanged and the pid cleared', async () => {
    const { code, err, dir } = await rerun(['--repo', 'nope'], fleet(), { seed: seed(TARGETS(), { pid: 1, startTime: '5' }) });
    expect(code).toBe(2);
    expect(err).toContain('unknown --repo "nope"');
    const record = await recordOf(dir);
    expect(status(record)).toEqual({ 'a:1': 'pending', 'a:2': 'pending', 'b:1': 'pending', 'g:1': 'gone' });
    expect(record).not.toHaveProperty('pid');
  });

  it('prompts only for the in-scope targets that need a send', async () => {
    const targets = [target('a:1', 'alpha', { messagePending: true, reason: null }), target('b:1', 'beta', { messagePending: true, reason: null })];
    const { questions } = await runCli(['broadcast', '--repo', 'alpha', '--timeout', '10s'], [{ paneKey: 'a:1', repo: 'alpha', behavior: acksWhenSent }, { paneKey: 'b:1', repo: 'beta', behavior: acksWhenSent }], withRepos({ seed: seed(targets), ask: ['y'] }));
    expect(questions).toEqual(['Send to 1 agent? [y/N] ']);
  });

  it('waits a fresh timeout on the in-scope targets only', async () => {
    const clock = fakeClock();
    await rerun(['--repo', 'alpha'], [{ paneKey: 'a:1', repo: 'alpha', behavior: silent() }, { paneKey: 'b:1', repo: 'beta', behavior: silent() }], { seed: seed(TARGETS()), clock });
    expect(clock.slept).toBeGreaterThanOrEqual(10_000);
  });
});

describe('close <filters> on a broadcast', () => {
  const close = (extra: string[], opts: RunCliOptions = {}) => runCli(['close', ...extra], [], withRepos({ seed: seed(TARGETS(), { pid: 999_999, startTime: '1' }), ...opts }));
  const recordOf = async (dir: string) => (await readRecords(dir))[0] as BroadcastRecord;

  it('abandons only the matching pending targets with reason closed; the record stays open while others are pending', async () => {
    const { code, out, dir, port } = await close(['--repo', 'alpha']);
    expect(code).toBe(0);
    expect(port.sends).toEqual([]);
    expect(out.split('\n')[0]).toBe('broadcast b-1 stays open: 2 targets abandoned');
    const record = await recordOf(dir);
    expect(status(record)).toEqual({ 'a:1': 'abandoned', 'a:2': 'abandoned', 'b:1': 'pending', 'g:1': 'gone' });
    expect(record.targets[0]?.reason).toBe('closed');
    expect(record.targets[3]?.reason).toBe('terminal-closed'); // gone is untouched
    expect(record.status).toBe('open');
    expect(record).not.toHaveProperty('pid');
    expect(await hasPointer(dir)).toBe(true);
    expect(out).toContain('beta'); // the table lists every recorded target
  });

  it('says "1 target" for one, and closes the record and clears the pointer when nothing is left pending', async () => {
    const first = await close(['--repo', 'beta']);
    expect(first.out.split('\n')[0]).toBe('broadcast b-1 stays open: 1 target abandoned');
    const all = await close(['--repo', 'alpha', '--repo', 'beta']);
    expect(all.out.split('\n')[0]).toBe('closed broadcast b-1');
    expect((await recordOf(all.dir)).status).toBe('closed');
    expect(await hasPointer(all.dir)).toBe(false);
  });

  it('prints "nothing to close" and the filters, exit 0, when nothing pending matches, leaving the record as it was', async () => {
    const { code, out, dir } = await close(['--repo', 'gamma']);
    expect(code).toBe(0);
    expect(out).toBe('nothing to close\nfilters: --repo gamma\n');
    const record = await recordOf(dir);
    expect(status(record)).toEqual({ 'a:1': 'pending', 'a:2': 'pending', 'b:1': 'pending', 'g:1': 'gone' });
    expect(record.pid).toBe(999_999);
  });

  it('takes --group, skipping its state kind with one stderr line', async () => {
    const { code, err, dir } = await close(['--group', 'mix'], { seed: async (store, d) => { await seedGroups({ mix: { repo: ['alpha'], state: ['done'] } })(store, d); await seed(TARGETS())(store, d); } });
    expect(code).toBe(0);
    expect(err).toContain('state filter skipped');
    expect(status(await recordOf(dir))).toMatchObject({ 'a:1': 'abandoned', 'a:2': 'abandoned', 'b:1': 'pending' });
  });

  it('exits 2 for an unknown value and leaves the record as it was', async () => {
    const { code, err, dir } = await close(['--repo', 'nope']);
    expect(code).toBe(2);
    expect(err).toContain('unknown --repo "nope"');
    expect(status(await recordOf(dir))).toMatchObject({ 'a:1': 'pending' });
  });

  it('resolves against the saved identity when Orca does not answer', async () => {
    const { code, dir } = await close(['--repo', 'alpha'], { seed: seed(TARGETS()), configure: (p) => (p.failListingsFrom = 1) });
    expect(code).toBe(0);
    expect(status(await recordOf(dir))).toMatchObject({ 'a:1': 'abandoned', 'b:1': 'pending' });
  });

  it("abandons the invoking session's own pending target like any other", async () => {
    const { dir } = await close(['--repo', 'alpha'], { env: { ORCA_PANE_KEY: 'a:1' } });
    expect(status(await recordOf(dir))).toMatchObject({ 'a:1': 'abandoned' });
  });

  it('keeps --json shape: the record, and nothing-to-do with record null', async () => {
    const partial = await close(['--repo', 'alpha', '--json']);
    expect(JSON.parse(partial.out)).toMatchObject({ command: 'close', outcome: 'done', exitCode: 0, run: null, record: { id: 'b-1', status: 'open' } });
    const none = await close(['--repo', 'gamma', '--json']);
    expect(JSON.parse(none.out)).toMatchObject({ outcome: 'nothing-to-do', record: null });
  });

  it('closes the pause run and leaves the broadcast to recovery when both kinds are open', async () => {
    const { code, out, dir } = await close(['--repo', 'alpha'], {
      seed: async (store) => {
        await seed(TARGETS())(store, '');
        await seedOpenRun(store, [agentRecord('a:1', { repoId: 'repo-alpha', repo: 'alpha' })]);
      },
    });
    expect(code).toBe(0);
    expect(out).not.toContain('broadcast b-1');
    expect(await readRecords(dir).then((r) => r[0]?.targets.map((t) => t.reason))).toEqual(['paused', 'paused', 'paused', 'terminal-closed']);
  });
});
