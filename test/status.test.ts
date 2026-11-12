import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { complete } from '../src/completion.js';
import { createRecordStore, type RecordStore, type StoreOptions } from '../src/store.js';
import type { BroadcastRecord, BroadcastTarget, RecoveryRecord, RecoveryRow } from '../src/types.js';
import { agentRecord, broadcastTarget, fakeClock, openBroadcastRecord, FakeOrca, pausedDone, seedOpenRun } from './helpers/fake-orca.js';
import { recoverRun } from './helpers/recover.js';
import { runCli, type RunCliOptions } from './helpers/run-cli.js';

const NOW = Date.parse('2026-05-01T10:00:00.000Z');
const stateOf = (dir: string): string => join(dir, 'orca-broadcast');
type Seed = NonNullable<RunCliOptions['seed']>;

/** A store with its own clock, so a seeded record carries a save stamp the test controls. */
const stampedStore = (dir: string, savedAtMs: number): RecordStore => createRecordStore(stateOf(dir), { now: () => savedAtMs });
const target = (paneKey: string, repo: string, worktree: string, extra: Partial<BroadcastTarget> = {}): BroadcastTarget => ({ ...broadcastTarget(paneKey), repo, worktree, ...extra });
const row = (sessionId: string, repo: string, worktree: string, extra: Partial<RecoveryRow> = {}): RecoveryRow => ({
  sessionId, paneKey: `old:${sessionId}`, repo, repoId: `id-${repo}`, worktree, worktreeId: `wt-${worktree}`, worktreePath: `/work/${worktree}`, role: 'worker', orchestrationRunIds: [],
  state: 'working', stateStartedAt: 1, savedAt: '2026-01-01T00:00:00.000Z', status: 'restarted', reason: null, promptDue: false, messagePending: false, baseline: null, ...extra,
});
const recoveryRecord = (rows: RecoveryRow[], extra: Partial<RecoveryRecord> = {}): RecoveryRecord => ({
  id: 'rec-1', token: 'abcd1234', createdAt: '2026-01-01T00:00:00.000Z', status: 'open', snapshotKey: { bootId: 'boot-0', runtimeId: 'runtime-0' }, liveRuntime: { bootId: 'boot-1', runtimeId: null }, snapshots: [], rows, ...extra,
});

const seedBroadcast = (record: BroadcastRecord, savedAtMs = NOW): Seed => async (_store, dir) => stampedStore(dir, savedAtMs).saveBroadcast(record);
const seedRecovery = (record: RecoveryRecord, savedAtMs = NOW): Seed => async (_store, dir) => stampedStore(dir, savedAtMs).saveRecovery(record);
const writeLock = (content: string): Seed => async (_store, dir) => {
  await mkdir(stateOf(dir), { recursive: true });
  await writeFile(join(stateOf(dir), 'lock'), content);
};
const both = (...seeds: Seed[]): Seed => async (store, dir) => {
  for (const seed of seeds) await seed(store, dir);
};
const status = (argv: string[], opts: RunCliOptions = {}) => runCli(['status', ...argv], [], { clock: fakeClock(NOW), ...opts });
const jsonOf = (out: string) => JSON.parse(out) as { command: string; open: Record<string, unknown> | null; outcome?: string; exitCode?: number };

describe('status with no open run', () => {
  it.each([
    ['a state folder that does not exist', undefined],
    ['an empty state folder', async (_s: RecordStore, dir: string) => void (await mkdir(stateOf(dir), { recursive: true }))],
  ])('prints "no open run" and exits 0 for %s', async (_name, seed) => {
    const { code, out, err } = await status([], { seed });
    expect({ code, out, err }).toEqual({ code: 0, out: 'no open run\n', err: '' });
  });

  it('prints {"command":"status","open":null} with --json', async () => {
    const { code, out, err } = await status(['--json']);
    expect(code).toBe(0);
    expect(out).toBe('{"command":"status","open":null}\n');
    expect(err).toBe('');
  });

  it('creates no folder in a missing state folder', async () => {
    const { dir } = await status([]);
    expect(await readdir(dir).catch(() => ['gone'])).toEqual(['gone']);
  });

  it('ignores a closed record', async () => {
    const { out } = await status([], { seed: seedBroadcast(openBroadcastRecord([target('a:1', 'r', 'w')], { status: 'closed' })) });
    expect(out).toBe('no open run\n');
  });
});

describe('status when the state cannot be read', () => {
  const unreadable: [string, Seed][] = [
    ['a record file that is not valid JSON', async (_s, dir) => { await mkdir(join(stateOf(dir), 'broadcasts'), { recursive: true }); await writeFile(join(stateOf(dir), 'broadcasts', 'bad.json'), '{'); }],
    ['a records folder that is a file', async (_s, dir) => { await mkdir(stateOf(dir), { recursive: true }); await writeFile(join(stateOf(dir), 'broadcasts'), 'x'); }],
    ['a lock path that is a directory', async (_s, dir) => { await mkdir(join(stateOf(dir), 'lock'), { recursive: true }); }],
  ];

  it.each(unreadable)('exits 2 with the message on stderr for %s', async (_name, seed) => {
    const { code, out, err } = await status([], { seed });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/^orca-broadcast: \S/);
  });

  it.each(unreadable)('exits 2 with the error object on stdout in --json for %s', async (_name, seed) => {
    const { code, out, err } = await status(['--json'], { seed });
    expect(code).toBe(2);
    expect(err).toBe('');
    expect(jsonOf(out)).toMatchObject({ command: 'status', outcome: 'error', exitCode: 2 });
  });

  it('names the file for invalid JSON', async () => {
    const { err } = await status([], { seed: unreadable[0]![1] });
    expect(err).toContain('unreadable record');
    expect(err).toContain('bad.json');
  });
});

describe('status of an open broadcast', () => {
  const targets = [
    target('a:1', 'repo-b', 'w1', { status: 'acked', reason: null }),
    target('a:2', 'repo-b', 'w1', { role: 'coordinator', status: 'pending', reason: 'waiting-permission' }),
    target('a:3', 'Zed', 'w9', { status: 'pending', reason: 'no-ack' }),
    target('a:4', 'alpha', 'w2', { status: 'gone', reason: 'terminal-closed' }),
    target('a:5', 'alpha', 'w1', { status: 'pending', reason: null }),
  ];
  const seed = seedBroadcast(openBroadcastRecord(targets));

  it('prints the header, the pending rows first, the done rows, and the count line', async () => {
    const { code, out } = await status([], { seed });
    expect(code).toBe(0);
    expect(out).toBe(
      [
        'broadcast b-1 · not running: re-run broadcast to continue · saved 0s ago',
        '  Zed/w9     session      pending  no-ack',
        '  alpha/w1   session      pending',
        '  repo-b/w1  coordinator  pending  waiting-permission',
        '  alpha/w2   session      gone     terminal-closed',
        '  repo-b/w1  session      acked',
        '2/5 acked, 3 pending',
        '',
      ].join('\n'),
    );
  });

  it('prints the same data in --json', async () => {
    const { out } = await status(['--json'], { seed });
    expect(jsonOf(out)).toEqual({
      command: 'status',
      open: {
        kind: 'broadcast', id: 'b-1', command: 'broadcast', running: false, savedAt: '2026-05-01T10:00:00.000Z', phase: null,
        counts: { done: 2, pending: 3, total: 5 },
        rows: [
          { repo: 'Zed', worktree: 'w9', role: 'session', status: 'pending', reason: 'no-ack' },
          { repo: 'alpha', worktree: 'w1', role: 'session', status: 'pending', reason: null },
          { repo: 'repo-b', worktree: 'w1', role: 'coordinator', status: 'pending', reason: 'waiting-permission' },
          { repo: 'alpha', worktree: 'w2', role: 'session', status: 'gone', reason: 'terminal-closed' },
          { repo: 'repo-b', worktree: 'w1', role: 'session', status: 'acked', reason: null },
        ],
        latestRecover: null,
      },
    });
  });

  it('keeps rows that are equal on repo, worktree and role in the order of the record', async () => {
    const equal = [target('a:1', 'r', 'w', { reason: 'no-ack' }), target('a:2', 'r', 'w', { reason: 'still-working' })];
    const { out } = await status([], { seed: seedBroadcast(openBroadcastRecord(equal)) });
    expect(out.indexOf('no-ack')).toBeLessThan(out.indexOf('still-working'));
  });

  it('prints 0/0 acked, 0 pending for a broadcast with no target', async () => {
    const { out } = await status([], { seed: seedBroadcast(openBroadcastRecord([])) });
    expect(out.split('\n').slice(1)).toEqual(['0/0 acked, 0 pending', '']);
  });
});

describe('status of an open recovery', () => {
  const rows = [
    row('s1', 'repo', 'w1', { status: 'acked' }),
    row('s2', 'repo', 'w2', { status: 'restarted', promptDue: true, reason: null }),
    row('s3', 'repo', 'w3', { status: 'pending', reason: 'awaiting-start' }),
    row('s4', 'repo', 'w4', { status: 'restarted', promptDue: false }),
  ];

  it('counts a restarted row with its prompt still due as pending, and uses the word final', async () => {
    const { out } = await status([], { seed: seedRecovery(recoveryRecord(rows)) });
    expect(out).toBe(
      [
        'recovery rec-1 · not running: re-run recover to continue · saved 0s ago',
        '  repo/w2  worker  restarted',
        '  repo/w3  worker  pending    awaiting-start',
        '  repo/w1  worker  acked',
        '  repo/w4  worker  restarted',
        '2/4 final, 2 pending',
        '',
      ].join('\n'),
    );
  });

  it('prints the kind, the command and the counts in --json', async () => {
    const { out } = await status(['--json'], { seed: seedRecovery(recoveryRecord(rows)) });
    expect(jsonOf(out).open).toMatchObject({ kind: 'recovery', id: 'rec-1', command: 'recover', phase: null, counts: { done: 2, pending: 2, total: 4 } });
  });

  it('prints 0/0 final, 0 pending for a recovery with no row', async () => {
    const { out } = await status([], { seed: seedRecovery(recoveryRecord([])) });
    expect(out.split('\n').slice(1)).toEqual(['0/0 final, 0 pending', '']);
  });

  it('shows the newer of a recovery and a broadcast, and a tie goes to the recovery', async () => {
    const older = openBroadcastRecord([target('a:1', 'r', 'w')], { createdAt: '2025-12-01T00:00:00.000Z' });
    expect((await status(['--json'], { seed: both(seedBroadcast(older), seedRecovery(recoveryRecord(rows))) })).out).toContain('"kind":"recovery"');
    const newer = openBroadcastRecord([target('a:1', 'r', 'w')], { createdAt: '2026-02-01T00:00:00.000Z' });
    expect((await status(['--json'], { seed: both(seedBroadcast(newer), seedRecovery(recoveryRecord(rows))) })).out).toContain('"kind":"broadcast"');
    const tie = openBroadcastRecord([target('a:1', 'r', 'w')], { createdAt: '2026-01-01T00:00:00.000Z' });
    expect((await status(['--json'], { seed: both(seedBroadcast(tie), seedRecovery(recoveryRecord(rows))) })).out).toContain('"kind":"recovery"');
  });
});

describe('status of an open pause run', () => {
  const seed: Seed = async (store) => void (await seedOpenRun(store, [agentRecord('a:1')]));

  it('prints the header alone and does not crash', async () => {
    const { code, out, err } = await status([], { seed });
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toMatch(/^pause run run-1 · not running: run pause again or resume to continue · saved \S+ ago\n$/);
  });

  it('prints an interim object in --json', async () => {
    const { code, out } = await status(['--json'], { seed });
    expect(code).toBe(0);
    expect(jsonOf(out).open).toMatchObject({ kind: 'pause', id: 'run-1', command: 'pause', running: false, phase: 'pause', counts: { done: 0, pending: 0, total: 0 }, rows: [], latestRecover: null });
  });

  it('wins over an open broadcast and leaves the broadcast open', async () => {
    const { out, dir } = await status([], { seed: both(seedBroadcast(openBroadcastRecord([target('a:1', 'r', 'w')])), seed) });
    expect(out).toContain('pause run run-1');
    expect(JSON.parse(await readFile(join(stateOf(dir), 'broadcasts', 'b-1.json'), 'utf8')).status).toBe('open');
  });
});

describe('status running and not running', () => {
  const record = seedBroadcast(openBroadcastRecord([target('a:1', 'r', 'w')]));

  it('says running for a live lock owner with the same start time', async () => {
    const { out } = await status([], { seed: both(record, writeLock('100 5000\n')), storeOptions: { isAlive: (pid) => pid === 100, readStartTime: () => '5000' } });
    expect(out.split('\n')[0]).toBe('broadcast b-1 · running · saved 0s ago');
    const json = await status(['--json'], { seed: both(record, writeLock('100 5000\n')), storeOptions: { isAlive: (pid) => pid === 100, readStartTime: () => '5000' } });
    expect(jsonOf(json.out).open).toMatchObject({ running: true });
  });

  it.each([
    ['no lock', undefined, { isAlive: () => false, readStartTime: () => undefined }],
    ['a dead owner', writeLock('4000000 5000\n'), { isAlive: () => false, readStartTime: () => undefined }],
    ['a live pid with another start time', writeLock('100 5000\n'), { isAlive: (pid: number) => pid === 100, readStartTime: () => '9999' }],
  ] as [string, Seed | undefined, StoreOptions][])('says not running for %s', async (_name, lock, storeOptions) => {
    const { out } = await status([], { seed: lock ? both(record, lock) : record, storeOptions });
    expect(out.split('\n')[0]).toBe('broadcast b-1 · not running: re-run broadcast to continue · saved 0s ago');
  });

  it('follows the pid-only rule when the lock file has no start time (FB-2)', async () => {
    const live = await status([], { seed: both(record, writeLock('100\n')), storeOptions: { isAlive: (pid) => pid === 100, readStartTime: () => '5000' } });
    expect(live.out).toContain(' · running · ');
    const dead = await status([], { seed: both(record, writeLock('100\n')), storeOptions: { isAlive: () => false, readStartTime: () => undefined } });
    expect(dead.out).toContain('not running');
  });
});

describe('status save age', () => {
  const header = async (savedAtMs: number, nowMs = NOW) => (await status([], { seed: seedBroadcast(openBroadcastRecord([]), savedAtMs), clock: fakeClock(nowMs) })).out.split('\n')[0];

  it.each([
    [0, 'saved 0s ago'],
    [12_000, 'saved 12s ago'],
    [12_900, 'saved 12s ago'],
    [59_000, 'saved 59s ago'],
    [60_000, 'saved 1:00 ago'],
    [65_000, 'saved 1:05 ago'],
    [3_600_000, 'saved 60:00 ago'],
  ])('prints %i ms as %s', async (ageMs, text) => {
    expect(await header(NOW - ageMs)).toContain(` · ${text}`);
  });

  it('prints saved 0s ago when the stamp is later than the clock (clock skew)', async () => {
    expect(await header(NOW + 90_000)).toContain(' · saved 0s ago');
  });

  const unstamped = async (_s: RecordStore, dir: string, savedAt?: string) => {
    await mkdir(join(stateOf(dir), 'broadcasts'), { recursive: true });
    const record = { ...openBroadcastRecord([]), ...(savedAt === undefined ? {} : { savedAt }) };
    await writeFile(join(stateOf(dir), 'broadcasts', 'b-1.json'), JSON.stringify(record));
  };

  it.each([
    ['a record without a stamp', undefined],
    ['a stamp that is not a date', 'yesterday'],
  ])('shows no age and a null savedAt for %s', async (_name, savedAt) => {
    const seed: Seed = (s, dir) => unstamped(s, dir, savedAt);
    const text = await status([], { seed });
    expect(text.out.split('\n')[0]).toBe('broadcast b-1 · not running: re-run broadcast to continue');
    expect(jsonOf((await status(['--json'], { seed })).out).open).toMatchObject({ savedAt: null });
  });
});

describe('status reads only', () => {
  it('takes no lock: a lock held by a live owner is unchanged and status still exits 0', async () => {
    const seed = both(seedBroadcast(openBroadcastRecord([target('a:1', 'r', 'w')])), writeLock('100 5000\n'));
    const { code, dir } = await status([], { seed, storeOptions: { isAlive: (pid) => pid === 100, readStartTime: () => '5000' } });
    expect(code).toBe(0);
    expect(await readFile(join(stateOf(dir), 'lock'), 'utf8')).toBe('100 5000\n');
  });

  it('leaves a stale lock in place too', async () => {
    const { dir } = await status([], { seed: writeLock('4000000 1\n'), storeOptions: { isAlive: () => false } });
    expect(await readFile(join(stateOf(dir), 'lock'), 'utf8')).toBe('4000000 1\n');
  });

  it('writes nothing and makes no Orca call', async () => {
    let port: FakeOrca | undefined;
    const seed = seedBroadcast(openBroadcastRecord([target('a:1', 'r', 'w')]));
    const before = new Map<string, string>();
    const result = await status([], {
      seed: async (s, dir) => {
        await seed(s, dir);
        for (const name of await readdir(join(stateOf(dir), 'broadcasts'))) before.set(name, await readFile(join(stateOf(dir), 'broadcasts', name), 'utf8'));
      },
      configure: (p) => {
        port = p;
        // Every Orca method fails the test at the call site, so a call that the counters miss still shows.
        for (const name of Object.getOwnPropertyNames(FakeOrca.prototype)) {
          if (name !== 'constructor' && typeof Reflect.get(p, name) === 'function') {
            Reflect.set(p, name, () => {
              throw new Error(`status called FakeOrca.${name}`);
            });
          }
        }
      },
    });
    expect(result.code).toBe(0);
    expect(port).toBeDefined();
    expect(port).toMatchObject({ sends: [], listCalls: 0, listTerminalsCalls: 0, listRunsCalls: 0, listWorkersCalls: 0, listReposCalls: 0, listWorktreesCalls: 0 });
    for (const [name, text] of before) expect(await readFile(join(stateOf(result.dir), 'broadcasts', name), 'utf8')).toBe(text);
    expect((await readdir(stateOf(result.dir))).sort()).toEqual(['broadcasts']);
  });

  it('runs without --yes and without a terminal', async () => {
    const { code } = await status([], { isTTY: false, seed: seedBroadcast(openBroadcastRecord([])) });
    expect(code).toBe(0);
  });
});

describe('status refusals', () => {
  it.each([
    [['now']],
    [['--yes']],
    [['--timeout', '5s']],
    [['--repo', 'x']],
    [['--group', 'g']],
    [['--file', 'f']],
    [['--bogus']],
  ])('refuses %j with exit 2 and a message on stderr', async (argv) => {
    const { code, out, err } = await status(argv);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/^orca-broadcast: \S/);
    expect(err).toContain('Usage: orca-broadcast status');
  });

  it.each([[['now']], [['--yes']], [['--repo', 'x']]])('refuses %j with the error object in --json', async (argv) => {
    const { code, out, err } = await status([...argv, '--json']);
    expect(code).toBe(2);
    expect(err).toBe('');
    expect(jsonOf(out)).toMatchObject({ outcome: 'error', exitCode: 2 });
  });
});

describe('help and completion of status', () => {
  it('prints its help with its usage line, its purpose and the exit codes', async () => {
    const { code, out } = await runCli(['status', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('Usage: orca-broadcast status\n');
    expect(out).toContain('Show the one open broadcast or recovery');
    expect(out).toContain('Exit 0 whenever it could read the state');
    expect(out).toContain('--json');
    expect(out).not.toContain('--timeout');
  });

  it('lists status in the main help', async () => {
    expect((await runCli(['--help'])).out).toMatch(/^ {2}status {2,}Show the one open/m);
  });

  it('completes status as a top word and --json and --help after it', () => {
    expect(complete(['st'], [])).toEqual(['status']);
    expect(complete(['status', '--'], []).sort()).toEqual(['--help', '--json']);
    expect(complete(['status', ''], []).sort()).toEqual(['--help', '--json']);
  });
});

describe('the other commands do not print the save stamp on their records', () => {
  const stamped = seedBroadcast(openBroadcastRecord([target('a:1', 'r', 'w')]));

  it('close --json of a stamped broadcast', async () => {
    const { out } = await runCli(['close', '--json'], [], { seed: stamped });
    expect(JSON.parse(out).record).not.toHaveProperty('savedAt');
  });

  it('broadcast --yes --json that continues a stamped broadcast', async () => {
    const { out } = await runCli(['broadcast', '--yes', '--json', '--timeout', '1s'], [{ paneKey: 'a:1', behavior: () => ({ state: 'working', message: null }) }], { seed: stamped });
    expect(JSON.parse(out).record).not.toHaveProperty('savedAt');
  });

  it('close --json of a stamped recovery keeps the per-row savedAt of its rows', async () => {
    const { out } = await runCli(['close', '--json'], [], { seed: seedRecovery(recoveryRecord([row('s1', 'repo', 'w1', { status: 'pending', reason: 'awaiting-start' })])) });
    const record = JSON.parse(out).record;
    expect(record).not.toHaveProperty('savedAt');
    expect(record.rows[0].savedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('close --json of a stamped pause run', async () => {
    const { out } = await runCli(['close', '--json'], [], { seed: async (store) => void (await seedOpenRun(store, [agentRecord('a:1')])) });
    expect(JSON.parse(out).run).not.toHaveProperty('savedAt');
  });

  it('pause --yes --json that widens a stamped pause run', async () => {
    const seed: Seed = async (store) => void (await seedOpenRun(store, [agentRecord('a:1')]));
    const { out } = await runCli(['pause', '--yes', '--json', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: pausedDone() }], { seed });
    expect(JSON.parse(out).run).not.toHaveProperty('savedAt');
  });

  it('recover --yes --json that continues a stamped recovery', async () => {
    const final = recoveryRecord([row('s1', 'repo', 'w1', { status: 'acked' })]);
    const { out } = await recoverRun(['--yes', '--json'], [], [], { seed: seedRecovery(final) });
    expect(JSON.parse(out).record).not.toHaveProperty('savedAt');
  });

  it('resume --yes --json of a stamped pause run', async () => {
    const { out } = await runCli(['resume', '--yes', '--json'], [], { seed: async (store) => void (await seedOpenRun(store, [agentRecord('a:1')])) });
    expect(JSON.parse(out).run).not.toHaveProperty('savedAt');
  });
});
