import { EventEmitter } from 'node:events';
import { readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeClock } from './helpers/fake-orca.js';
import { doneEntry, GONE, parseJson, recoverRun, resultsOf } from './helpers/recover.js';
import { readPointer, readRecoveries, storeDir } from './helpers/records.js';
import { agent, rosterEntry, rosterNames, rosterSnapshot, scanOf, seedRosters, T0 } from './helpers/roster.js';
import { runCli, type Seed } from './helpers/run-cli.js';
import type { RecoveryRecord, RosterEntry, StartResult } from '../src/types.js';

const BYPASS = '--permission-mode bypassPermissions';
const LOCK_MESSAGE = 'another orca-broadcast is running';

// The roster of the runtime that is gone, and a way to learn the state folder while the run is still going.
const seedAnd =
  (entries: RosterEntry[], capture: (dir: string) => void = () => {}): Seed =>
  async (store, dir) => {
    await seedRosters(rosterSnapshot(GONE, entries))(store);
    capture(dir);
  };

// An agent whose row and terminal exist from this listing number on (listing 1 is the first snapshot, 2 the scan before the first start).
const appears = (paneKey: string, from: number) => agent(paneKey, { rowAt: (n) => n >= from, terminalAt: (n) => (n >= from ? 'ok' : 'missing') });

// The scan from this scan number on holds the session on this pane.
const joinedFrom = (sessionId: string, paneKey: string, from: number) => (n: number) => (n >= from ? scanOf({ sessionId, paneKey, startTime: 5 }) : scanOf());

const only = (dir: string): RecoveryRecord => {
  const [record, ...others] = readRecoveries(dir);
  expect(others).toEqual([]);
  return record as RecoveryRecord;
};

describe('the record and the starts', () => {
  it('writes the record and the pointer before the first start, stores each start before it is made, and closes by itself', async () => {
    let home = '';
    const atStart: { record: RecoveryRecord | undefined; pointer: unknown }[] = [];
    const { code, out, dir, port } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [], {
      seed: seedAnd([doneEntry('s-a', { permission: BYPASS })], (d) => (home = d)),
      scan: joinedFrom('s-a', 'new:a', 3),
      newToken: () => 'tok1',
      configure: (p) => {
        p.startResultAt = (n) => {
          atStart.push({ record: readRecoveries(home)[0], pointer: readPointer(home) });
          return { started: true, handle: `term_${n}` };
        };
      },
    });
    expect(code).toBe(0);
    expect(atStart).toHaveLength(1);
    const before = atStart[0]?.record as RecoveryRecord;
    expect(before).toMatchObject({ status: 'open', token: 'tok1' });
    expect(before.pid).toBeTypeOf('number');
    expect(before.rows[0]).toMatchObject({ sessionId: 's-a', status: 'pending', reason: 'awaiting-start' });
    expect(before.rows[0]?.startedAt).toBeTypeOf('string');
    expect(atStart[0]?.pointer).toEqual({ kind: 'recovery', id: before.id });

    expect(port.starts).toEqual([{ worktreePath: '/work/tree-s-a', sessionId: 's-a', permission: BYPASS, title: 'repo/tree-s-a (recovered)' }]);
    const record = only(dir);
    expect(record).toMatchObject({ id: before.id, status: 'closed', endedBy: 'done', snapshotKey: GONE, liveRuntime: { bootId: 'boot-1', runtimeId: 'runtime-1' } });
    expect(record.pid).toBeUndefined();
    expect(record.rows[0]).toMatchObject({ status: 'restarted', reason: null, repo: 'repo', repoId: 'repo-repo', worktreeId: 'wt-s-a', role: 'session', orchestrationRunIds: [] });
    expect(record.snapshots).toHaveLength(1);
    expect(readPointer(dir)).toBeNull();
    const line = parseJson(out);
    expect(line.record).toEqual(record);
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted' });
    // The first scan, the scan before the start, the scan that joins the new pane, and the end roster save.
    expect(port.scanCalls).toBe(4);
    expect(await rosterNames(dir)).toEqual(['boot-0-runtime-0.json', 'boot-1-runtime-1.json']);
  });

  it('restarts coordinators first, never a worker, and passes the recorded permission flag', async () => {
    const entries = [
      doneEntry('s-b'),
      doneEntry('s-c', { role: 'coordinator' }),
      doneEntry('s-a', { permission: '--dangerously-skip-permissions' }),
      rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-c' }),
    ];
    const { port, out } = await recoverRun(['--yes', '--json'], [], entries);
    expect(port.starts.map((s) => [s.sessionId, s.permission])).toEqual([['s-c', null], ['s-a', '--dangerously-skip-permissions'], ['s-b', null]]);
    // Its coordinator never appeared, so it got no list.
    expect(resultsOf(out)).toMatchObject({ 's-c': 'failed/did-not-appear', 's-w': 'no-coordinator/coordinator-missing' });
  });

  it('keeps the record open when the prompt is sent and not acked: the restarted row is pending still-working and the exit is 1', async () => {
    const { code, out, dir } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [rosterEntry('s-a')], { scan: joinedFrom('s-a', 'new:a', 3) });
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/still-working' });
    const record = only(dir);
    expect(record).toMatchObject({ status: 'open' });
    expect(record.endedBy).toBeUndefined();
    expect(record.pid).toBeUndefined();
    expect(record.rows[0]).toMatchObject({ status: 'pending', reason: 'still-working', promptDue: true, messagePending: false });
    expect(record.rows[0]?.startedAt).toBeTypeOf('string');
    expect(readPointer(dir)).toEqual({ kind: 'recovery', id: record.id });
  });

  it('puts every refusal reason on its failed row, the start-failed message in warnings, and keeps a stored start only for start-failed', async () => {
    const results: StartResult[] = [
      { started: false, reason: 'invalid-session-id' },
      { started: false, reason: 'flag-not-allowed' },
      { started: false, reason: 'no-transcript' },
      { started: false, reason: 'start-failed', message: 'orca-ide terminal create failed: down' },
    ];
    const entries = ['s-1', 's-2', 's-3', 's-4'].map((id) => doneEntry(id));
    const { code, out, dir, port } = await recoverRun(['--yes', '--json'], [], entries, { configure: (p) => (p.startResultAt = (n) => results[n - 1] as StartResult) });
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-1': 'failed/invalid-session-id', 's-2': 'failed/flag-not-allowed', 's-3': 'failed/no-transcript', 's-4': 'failed/start-failed' });
    expect(parseJson(out).warnings).toEqual(['orca-ide terminal create failed: down']);
    const record = only(dir);
    expect(record.rows.map((row) => row.startedAt !== undefined)).toEqual([false, false, false, true]);
    // Every row is final, so the record closed by itself; nothing was started, so there is no end snapshot and no end scan.
    expect(record).toMatchObject({ status: 'closed', endedBy: 'done' });
    expect(port.scanCalls).toBe(5);
    expect(port.listCalls).toBe(5);
  });

  it('writes no record when nothing is due, and none after a no', async () => {
    const quiet = await recoverRun(['--yes', '--json'], [agent('new:a')], [doneEntry('s-a')], { scan: scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }) });
    expect(quiet.code).toBe(0);
    expect(readRecoveries(quiet.dir)).toEqual([]);
    expect(parseJson(quiet.out).record).toBeNull();
    const declined = await recoverRun([], [], [doneEntry('s-a')], { ask: ['n'] });
    expect(declined.code).toBe(1);
    expect(readRecoveries(declined.dir)).toEqual([]);
  });
});

describe('the scan before each start', () => {
  it('takes one listing and one scan before each start; a held, unverifiable or restored session is not started, with no re-check', async () => {
    const entries = ['s-a', 's-b', 's-c', 's-d'].map((id) => doneEntry(id));
    const scan = (n: number) => {
      if (n === 3) return scanOf({ sessionId: 's-b', paneKey: null });
      if (n === 4) return { sessions: [], unknown: [{ cwd: '/work/tree-s-c' }], heldByOthers: [] };
      if (n === 5) return scanOf({ sessionId: 's-d', paneKey: 'new:d', startTime: 5 });
      return scanOf();
    };
    const { out, port, clock } = await recoverRun(['--yes', '--json'], [appears('new:d', 5)], entries, { scan });
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/did-not-appear', 's-b': 'failed/session-held', 's-c': 'failed/unverifiable', 's-d': 'restored' });
    // One scan for the roster start, one for each of the four rows, and the end roster save: none in the wait (no unjoined live row).
    expect(port.scanCalls).toBe(6);
    expect(clock.slept).toBeGreaterThan(0);
  });

  it('a failed scan before a start fails this row and every later one, starts nothing more, and makes no listing for the later rows', async () => {
    const entries = ['s-a', 's-b', 's-c'].map((id) => doneEntry(id));
    const { out, port } = await recoverRun(['--yes', '--json'], [], entries, { configure: (p) => (p.failScansFrom = 3) });
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/did-not-appear', 's-b': 'failed/scan-failed', 's-c': 'failed/scan-failed' });
    // Listings: the first snapshot, the scan before s-a, the scan before s-b (it failed), and the wait ticks; none for s-c.
    expect(port.scanCalls).toBeGreaterThanOrEqual(3);
  });

  it('a deadline that comes before a start leaves the row pending timed-out', async () => {
    const clock = fakeClock(T0);
    const entries = ['s-a', 's-b'].map((id) => doneEntry(id));
    const { out, port } = await recoverRun(['--yes', '--json', '--timeout', '2s'], [], entries, {
      clock,
      configure: (p) => (p.startResultAt = (n) => ((clock.slept += 3000), { started: true, handle: `term_${n}` })),
    });
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/did-not-appear', 's-b': 'pending/timed-out' });
  });

  it('a row after a failed scan stays failed scan-failed even when the deadline has passed', async () => {
    const clock = fakeClock(T0);
    const entries = ['s-a', 's-b', 's-c'].map((id) => doneEntry(id));
    const scan = (n: number) => {
      if (n === 3) {
        clock.slept += 5000;
        throw new Error('boom');
      }
      return scanOf();
    };
    const { out, port } = await recoverRun(['--yes', '--json', '--timeout', '2s'], [], entries, { clock, scan });
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/did-not-appear', 's-b': 'failed/scan-failed', 's-c': 'failed/scan-failed' });
  });
});

describe('the appearance wait', () => {
  it('scans in a tick only when a live row is not yet joined, and waits 2 seconds between ticks', async () => {
    const entries = [doneEntry('s-a'), doneEntry('s-x')];
    const scan = (n: number) => (n >= 3 ? scanOf({ sessionId: 's-x', paneKey: 'new:x', startTime: 6 }, { sessionId: 's-a', paneKey: 'new:a', startTime: 5 }) : scanOf({ sessionId: 's-x', paneKey: 'new:x', startTime: 6 }));
    const { out, port, clock } = await recoverRun(['--yes', '--json'], [agent('new:x'), appears('new:a', 5)], entries, { scan });
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted', 's-x': 'restored' });
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    // Listings 3 and 4 have no unjoined live row; listing 5 shows new:a, which the scan before the start did not know: one scan.
    // The scans: the first, the scan before the start, the join scan, and the end roster save.
    expect(port.scanCalls).toBe(4);
    expect(clock.slept).toBe(4000);
  });

  it('a scan that fails in a tick joins nothing, and the next tick scans again', async () => {
    const scan = (n: number) => {
      if (n === 3) throw new Error('boom');
      return n >= 4 ? scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }) : scanOf();
    };
    const { out, clock, port } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [doneEntry('s-a')], { scan });
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted' });
    expect(clock.slept).toBe(2000);
    expect(port.scanCalls).toBe(5);
  });

  it('ends failed scan-failed when a live row stays unjoined and the last scan failed, and did-not-appear when the scan works', async () => {
    const broken = await recoverRun(['--yes', '--json', '--timeout', '10s'], [appears('new:a', 3)], [doneEntry('s-a')], { scan: (n) => { if (n >= 3 && n < 20) throw new Error('boom'); return scanOf(); } });
    expect(resultsOf(broken.out)).toEqual({ 's-a': 'failed/scan-failed' });
    const working = await recoverRun(['--yes', '--json', '--timeout', '10s'], [appears('new:a', 3)], [doneEntry('s-a')], { scan: scanOf() });
    expect(resultsOf(working.out)).toEqual({ 's-a': 'failed/did-not-appear' });
  });

  it('makes one tick even when the deadline has already passed', async () => {
    const clock = fakeClock(T0);
    const { out, port } = await recoverRun(['--yes', '--json', '--timeout', '2s'], [appears('new:a', 3)], [doneEntry('s-a')], {
      clock,
      scan: joinedFrom('s-a', 'new:a', 3),
      configure: (p) => (p.startResultAt = (n) => ((clock.slept += 9000), { started: true, handle: `term_${n}` })),
    });
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted' });
    expect(port.listCalls).toBeGreaterThanOrEqual(3);
  });

  it('does not count the wait for the confirmation toward --timeout', async () => {
    const clock = fakeClock(T0);
    await recoverRun(['--timeout', '4s'], [], [doneEntry('s-a')], {
      clock,
      ask: [() => ((clock.slept += 60_000), 'y')],
    });
    // The wait lasts the 4 seconds of --timeout after the 60 seconds of the confirmation.
    expect(clock.slept).toBe(60_000 + 4000);
  });
});

describe('the end of a run', () => {
  it('saves the roster once at the end only when an agent was started', async () => {
    const started = await recoverRun(['--yes'], [appears('new:a', 3)], [doneEntry('s-a')], { scan: joinedFrom('s-a', 'new:a', 3) });
    expect(started.port.scanCalls).toBe(4);
    const refused = await recoverRun(['--yes'], [], [doneEntry('s-a')], { configure: (p) => (p.startResultAt = () => ({ started: false, reason: 'no-transcript' })) });
    expect(refused.port.scanCalls).toBe(2);
    expect(refused.port.listCalls).toBe(2);
  });

  it('a failed end snapshot leaves the record open and exits 2', async () => {
    const { code, out, dir } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [doneEntry('s-a')], {
      scan: joinedFrom('s-a', 'new:a', 3),
      configure: (p) => (p.failListingsFrom = 4),
    });
    expect(code).toBe(2);
    const line = parseJson(out);
    expect([line.outcome, line.exitCode]).toEqual(['error', 2]);
    expect(line.error).toContain('worktree ps failed');
    const record = only(dir);
    expect(record.status).toBe('open');
    expect(record.pid).toBeUndefined();
    expect(line.record).toEqual(record);
    expect(readPointer(dir)).toEqual({ kind: 'recovery', id: record.id });
  });
});

describe('errors, signals and the lock', () => {
  it('a listing that fails after the first snapshot ends with error, exit 2 and the record left open', async () => {
    const { code, out, dir } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { configure: (p) => (p.failListingsFrom = 3) });
    expect(code).toBe(2);
    const line = parseJson(out);
    expect([line.outcome, line.exitCode]).toEqual(['error', 2]);
    const record = only(dir);
    expect(record).toMatchObject({ status: 'open' });
    expect(record.pid).toBeUndefined();
    expect(record.rows[0]).toMatchObject({ status: 'pending', reason: 'awaiting-start' });
    expect(record.rows[0]?.startedAt).toBeTypeOf('string');
    expect(line.rows.map((row) => [row.sessionId, row.status, row.reason])).toEqual([['s-a', 'pending', 'awaiting-start']]);
    expect(line.record).toEqual(record);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('%s during the wait saves the record with the pid cleared and exits 130', async (name) => {
    const signals = new EventEmitter();
    const { code, out, dir } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { signals, onSleep: () => signals.emit(name) });
    expect(code).toBe(130);
    const line = parseJson(out);
    expect([line.outcome, line.exitCode, line.error]).toEqual(['error', 130, `interrupted by ${name}`]);
    const record = only(dir);
    expect(record.status).toBe('open');
    expect(record.pid).toBeUndefined();
    expect(record.rows[0]).toMatchObject({ status: 'pending', reason: 'awaiting-start' });
    expect(record.rows[0]?.startedAt).toBeTypeOf('string');
    expect(line.record).toEqual(record);
    expect(readPointer(dir)).toEqual({ kind: 'recovery', id: record.id });
  });

  it('a signal during the starts saves the record too, and no roster is saved after it', async () => {
    const signals = new EventEmitter();
    const { code, dir, port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a'), doneEntry('s-b')], {
      signals,
      configure: (p) => (p.startResultAt = (n) => (signals.emit('SIGTERM'), { started: true, handle: `term_${n}` })),
    });
    expect(code).toBe(130);
    expect(port.starts).toHaveLength(1);
    expect(only(dir).rows.map((row) => row.status)).toEqual(['pending', 'pending']);
    expect(await rosterNames(dir)).toEqual(['boot-0-runtime-0.json', 'boot-1-runtime-1.json']);
  });

  it('refuses at step 3 when the pointer cannot be written: nothing is started, the pid is cleared, exit 2', async () => {
    const { code, err, port, dir } = await recoverRun(['--yes'], [], [], {
      seed: async (store, d) => {
        await seedRosters(rosterSnapshot(GONE, [doneEntry('s-a')]))(store);
        await mkdir(join(storeDir(d), 'current'), { recursive: true });
      },
    });
    expect(code).toBe(2);
    expect(err).toContain('orca-broadcast:');
    expect(port.starts).toEqual([]);
    expect(only(dir).pid).toBeUndefined();
  });

  it('holds the lock while it waits, and refuses to run while another process holds it', async () => {
    let home = '';
    const seen: boolean[] = [];
    await recoverRun(['--yes'], [], [], {
      seed: seedAnd([doneEntry('s-a')], (d) => (home = d)),
      onSleep: () => seen.push(readdirSync(storeDir(home)).includes('lock')),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);

    const seedLock: Seed = async (store, d) => {
      await seedRosters(rosterSnapshot(GONE, [doneEntry('s-a')]))(store);
      await writeFile(join(storeDir(d), 'lock'), '4242 77\n');
    };
    const options = { pid: 999, isAlive: () => true, readStartTime: () => '77' };
    const held = await recoverRun(['--yes'], [], [], { seed: seedLock, storeOptions: options });
    expect(held.code).toBe(2);
    expect(held.err).toContain(LOCK_MESSAGE);
    expect(held.port.listCalls).toBe(0);
  });

  it('pause refuses with the usual lock message and touches no record while the lock is held', async () => {
    const seed: Seed = async (_store, d) => {
      await mkdir(storeDir(d), { recursive: true });
      await writeFile(join(storeDir(d), 'lock'), '4242 77\n');
    };
    const { code, err, dir, port } = await runCli(['pause', '--yes'], [agent('a:1')], { seed, storeOptions: { pid: 999, isAlive: () => true, readStartTime: () => '77' } });
    expect(code).toBe(2);
    expect(err).toContain(LOCK_MESSAGE);
    expect(port.sends).toEqual([]);
    expect(readRecoveries(dir)).toEqual([]);
  });
});

describe('a recovery open beside a broadcast', () => {
  const open = (id: string): RecoveryRecord => ({ id, token: 'tok', createdAt: '2026-01-01T00:00:00.000Z', status: 'open', snapshotKey: GONE, liveRuntime: { bootId: 'boot-1', runtimeId: 'runtime-1' }, snapshots: [], rows: [] });

  it('prints only the broken-state message when a broadcast is open beside the recovery, not the broadcast or the open-recovery message', async () => {
    const seed: Seed = async (store) => {
      await seedRosters(rosterSnapshot(GONE, [doneEntry('s-a')]))(store);
      await store.saveRecovery(open('r1'));
      await store.saveBroadcast({ id: 'b1', token: 'tok', text: 'hi', createdAt: '2026-01-02T00:00:00.000Z', status: 'open', targets: [] });
    };
    const { err } = await recoverRun(['--yes'], [], [], { seed });
    expect(err).toContain('a recovery and a broadcast are both open; run `orca-broadcast close` and then `recover` again');
    expect(err).not.toContain('a recovery is open;');
    expect(err).not.toContain('a broadcast is still open');
  });
});
