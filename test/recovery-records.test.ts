import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { abandonRecovery } from '../src/recover-record.js';
import type { BroadcastRecord, RecoveryRecord, RecoveryRow } from '../src/types.js';
import { broadcastTarget, openBroadcastRecord, repliesWithToken, seedOpenRun, agentRecord } from './helpers/fake-orca.js';
import { GONE } from './helpers/recover.js';
import { hasPointer, readBroadcasts, readPointer, readRecoveries, storeDir } from './helpers/records.js';
import { rosterEntry } from './helpers/roster.js';
import { runCli, type Seed } from './helpers/run-cli.js';

const LOCK_MESSAGE = 'another orca-broadcast is running';
const BROKEN_STATE = 'a recovery and a broadcast are both open; run `orca-broadcast close` and then `recover` again';

const row = (sessionId: string, status: RecoveryRow['status'], extra: Partial<RecoveryRow> = {}): RecoveryRow => ({
  ...rosterEntry(sessionId),
  status,
  reason: null,
  promptDue: false,
  messagePending: false,
  baseline: null,
  ...extra,
});

const recovery = (rows: RecoveryRow[], extra: Partial<RecoveryRecord> = {}): RecoveryRecord => ({
  id: 'r1',
  token: '***',
  createdAt: '2026-01-02T00:00:00.000Z',
  status: 'open',
  snapshotKey: GONE,
  liveRuntime: { bootId: 'boot-1', runtimeId: 'runtime-1' },
  snapshots: [{ lastSave: '2026-01-01T00:00:00.000Z', ageMinutes: 5 }],
  rows,
  ...extra,
});

// Two rows that are not final (one a worker), one acked row and one failed row.
const mixedRows = (): RecoveryRow[] => [
  row('s-a', 'pending', { reason: 'timed-out', promptDue: true }),
  row('s-w', 'pending', { reason: 'timed-out', role: 'worker' }),
  row('s-ok', 'acked'),
  row('s-bad', 'failed', { reason: 'did-not-appear', role: 'worker' }),
];

const seedRecovery =
  (record: RecoveryRecord): Seed =>
  async (store) => {
    await store.saveRecovery(record);
    await store.setCurrent('recovery', record.id);
  };

const broadcastRecord = (extra: Partial<BroadcastRecord> = {}): BroadcastRecord => openBroadcastRecord([broadcastTarget('a:1')], { createdAt: '2026-01-01T00:00:00.000Z', ...extra });

// A recovery and a broadcast open together, as a crash between two writes can leave them.
const seedBroken =
  (rows = mixedRows()): Seed =>
  async (store) => {
    await store.saveBroadcast(broadcastRecord());
    await seedRecovery(recovery(rows))(store, '');
  };

const only = (dir: string): RecoveryRecord => {
  const [record, ...rest] = readRecoveries(dir);
  expect(rest).toEqual([]);
  return record as RecoveryRecord;
};

describe('abandonRecovery', () => {
  it('abandons the rows that are not final, keeps the final ones, drops the pid and closes the record', () => {
    const record = recovery([...mixedRows(), row('s-r1', 'restored'), row('s-r2', 'restarted', { promptDue: true })], { pid: 7, startTime: '9' });
    expect(abandonRecovery(record, 'closed')).toBe(3);
    expect(record.rows.map((r) => [r.sessionId, r.status, r.reason])).toEqual([
      ['s-a', 'abandoned', 'closed'],
      ['s-w', 'abandoned', 'closed'],
      ['s-ok', 'acked', null],
      ['s-bad', 'failed', 'did-not-appear'],
      ['s-r1', 'restored', null],
      ['s-r2', 'abandoned', 'closed'],
    ]);
    expect(record).toMatchObject({ status: 'closed', endedBy: 'abandoned' });
    expect(record).not.toHaveProperty('pid');
    expect(record).not.toHaveProperty('startTime');
  });

  it('abandons only the rows the selector accepts, and then stays open without a pid', () => {
    const record = recovery(mixedRows(), { pid: 7, startTime: '9' });
    expect(abandonRecovery(record, 'paused', (r) => r.role === 'worker')).toBe(1);
    expect(record.rows.map((r) => r.status)).toEqual(['pending', 'abandoned', 'acked', 'failed']);
    expect(record.status).toBe('open');
    expect(record).not.toHaveProperty('endedBy');
    expect(record).not.toHaveProperty('pid');
  });

  it('abandons a worker that waits for a pending coordinator in a full abandon, and leaves it final when only the coordinator goes', () => {
    const rows = () => [row('s-c', 'pending', { reason: 'timed-out', role: 'coordinator' }), row('s-w', 'no-coordinator', { reason: 'coordinator-missing', role: 'worker', coordinatorSessionId: 's-c' })];
    const full = recovery(rows());
    expect(abandonRecovery(full, 'closed')).toBe(2);
    expect(full.rows.map((r) => r.status)).toEqual(['abandoned', 'abandoned']);

    const partial = recovery(rows());
    expect(abandonRecovery(partial, 'closed', (r) => r.role === 'coordinator')).toBe(1);
    expect(partial.rows.map((r) => r.status)).toEqual(['abandoned', 'no-coordinator']);
    expect(partial).toMatchObject({ status: 'closed', endedBy: 'abandoned' });
  });
});

describe('close and a recovery', () => {
  it('abandons every row that is not final, prints the heading and the table, clears the pointer and exits 0', async () => {
    const { code, out, err, dir, port } = await runCli(['close'], [], { seed: seedRecovery(recovery(mixedRows(), { pid: 99 })) });
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out.startsWith('closed recovery r1\n')).toBe(true);
    expect(out).toContain('abandoned');
    expect(out).toContain('did-not-appear');
    expect(out).not.toContain('snapshot ');
    expect(port.sends).toEqual([]);
    const record = only(dir);
    expect(record).toMatchObject({ status: 'closed', endedBy: 'abandoned' });
    expect(record).not.toHaveProperty('pid');
    expect(record.rows.map((r) => [r.status, r.reason])).toEqual([['abandoned', 'closed'], ['abandoned', 'closed'], ['acked', null], ['failed', 'did-not-appear']]);
    expect(await hasPointer(dir)).toBe(false);
  });

  it('with a filter abandons only the matching rows, and says the record stays open', async () => {
    const { code, out, dir } = await runCli(['close', '--role', 'worker'], [], { seed: seedRecovery(recovery(mixedRows())) });
    expect(code).toBe(0);
    expect(out.startsWith('recovery r1 stays open\n')).toBe(true);
    const record = only(dir);
    expect(record.status).toBe('open');
    expect(record.rows.map((r) => r.status)).toEqual(['pending', 'abandoned', 'acked', 'failed']);
    expect(readPointer(dir)).toEqual({ kind: 'recovery', id: 'r1' });
  });

  it('with a filter closes the record when every row is final afterwards', async () => {
    const { out, dir } = await runCli(['close', '--role', 'session'], [], { seed: seedRecovery(recovery([row('s-a', 'pending', { reason: 'timed-out' }), row('s-ok', 'acked', { role: 'worker' })])) });
    expect(out.startsWith('closed recovery r1\n')).toBe(true);
    expect(only(dir).status).toBe('closed');
    expect(await hasPointer(dir)).toBe(false);
  });

  it.each([
    ['no row matches', ['close', '--role', 'coordinator']],
    ['only final rows match', ['close', '--worktree', '/work/tree-s-ok']],
  ])('says nothing to close, with the filters, and changes nothing when %s', async (_name, argv) => {
    const { code, out, dir } = await runCli(argv, [], { seed: seedRecovery(recovery(mixedRows())) });
    expect(code).toBe(0);
    expect(out).toContain('nothing to close\nfilters: ');
    expect(only(dir).rows.map((r) => r.status)).toEqual(['pending', 'pending', 'acked', 'failed']);
  });

  it('prints the recovery record in `record` of the --json line, with no abandoned field', async () => {
    const { code, out } = await runCli(['close', '--json'], [], { seed: seedRecovery(recovery(mixedRows())) });
    expect(code).toBe(0);
    const line = JSON.parse(out) as Record<string, unknown> & { record: RecoveryRecord };
    expect(line).toMatchObject({ command: 'close', outcome: 'done', exitCode: 0, run: null, error: null, warnings: [] });
    expect(line.record).toMatchObject({ id: 'r1', status: 'closed', endedBy: 'abandoned' });
    expect(line).not.toHaveProperty('abandoned');
  });
});

describe('a recovery beside a broadcast (the broken state)', () => {
  it('makes recover refuse with only the broken-state message, and touch nothing', async () => {
    const { code, err, dir, port } = await runCli(['recover', '--yes'], [], { seed: seedBroken() });
    expect(code).toBe(2);
    expect(err).toContain(BROKEN_STATE);
    expect(err).not.toContain('a broadcast is still open');
    expect(err).not.toContain('a recovery is open');
    expect([port.listCalls, port.scanCalls]).toEqual([0, 0]);
    expect(only(dir).status).toBe('open');
    expect((await readBroadcasts(dir))[0]?.status).toBe('open');
  });

  it('is reported by the load: close prints a note, then abandons both records and prints both lines', async () => {
    const { code, out, err, dir } = await runCli(['close'], [], { seed: seedBroken() });
    expect(code).toBe(0);
    expect(err).toContain('recovery r1 and broadcast b-1 are both open; run orca-broadcast close to abandon both');
    expect(out.startsWith('closed recovery r1\nclosed broadcast b-1\n')).toBe(true);
    expect(only(dir)).toMatchObject({ status: 'closed', endedBy: 'abandoned' });
    const [broadcast] = await readBroadcasts(dir);
    expect(broadcast).toMatchObject({ status: 'closed' });
    expect(broadcast?.targets[0]).toMatchObject({ status: 'abandoned', reason: 'closed' });
    expect(await hasPointer(dir)).toBe(false);
  });

  it('puts `closed broadcast <id>` in the warnings of the --json line, after the load note', async () => {
    const { code, out } = await runCli(['close', '--json'], [], { seed: seedBroken() });
    expect(code).toBe(0);
    const line = JSON.parse(out) as { record: RecoveryRecord; warnings: string[] };
    expect(line.record.id).toBe('r1');
    expect(line.warnings).toEqual(['recovery r1 and broadcast b-1 are both open; run orca-broadcast close to abandon both', 'closed broadcast b-1']);
  });

  it('refuses a close with filters (exit 2) and changes no record', async () => {
    const { code, err, dir } = await runCli(['close', '--role', 'worker'], [], { seed: seedBroken() });
    expect(code).toBe(2);
    expect(err).toContain('a recovery and a broadcast are both open; run `orca-broadcast close` without filters');
    expect(only(dir).status).toBe('open');
    expect((await readBroadcasts(dir))[0]?.status).toBe('open');
  });
});

describe('a recovery beside a pause run', () => {
  const seedBeside: Seed = async (store) => {
    await seedOpenRun(store, [agentRecord('a:1', { resumeStatus: 'resumed' })]);
    await store.saveRecovery(recovery(mixedRows()));
  };

  it('is abandoned by the next command that loads the records, with its own note', async () => {
    const { err, dir } = await runCli(['resume', '--yes'], [], { seed: seedBeside });
    expect(err).toContain('recovery r1 was open beside a pause run; abandoned');
    expect(only(dir).rows.map((r) => [r.status, r.reason])).toEqual([['abandoned', 'paused'], ['abandoned', 'paused'], ['acked', null], ['failed', 'did-not-appear']]);
    expect(only(dir)).toMatchObject({ status: 'closed', endedBy: 'abandoned' });
  });

  it('is abandoned and then absent for close, which acts on the pause run as it did before', async () => {
    const { code, out, dir } = await runCli(['close'], [], { seed: seedBeside });
    expect(code).toBe(0);
    expect(out).not.toContain('recovery');
    expect(only(dir).status).toBe('closed');
  });

  it('makes recover refuse with the pause-run message, and leaves the recovery open until a command loads the records', async () => {
    const { code, err, dir } = await runCli(['recover', '--yes'], [], { seed: seedBeside });
    expect(code).toBe(2);
    expect(err).toContain('a pause run is open');
    expect(only(dir).status).toBe('open');
  });

  it('does not print the broken-state note when a broadcast is open too: both are abandoned', async () => {
    const seedAll: Seed = async (store, dir) => {
      await seedBeside(store, dir);
      await store.saveBroadcast(broadcastRecord());
    };
    const { err, dir } = await runCli(['resume', '--yes'], [], { seed: seedAll });
    expect(err).not.toContain('are both open');
    expect(err).toContain('recovery r1 was open beside a pause run; abandoned');
    expect(err).toContain('broadcast b-1 was open beside a pause run and is now abandoned');
    expect(only(dir).status).toBe('closed');
  });
});

describe('broadcast with a recovery open', () => {
  const MESSAGE = 'a recovery is open; re-run recover or close it';

  it.each([
    ['with a text', ['broadcast', 'hello', '--yes']],
    ['with no text', ['broadcast', '--yes']],
  ])('refuses %s (exit 2), sends nothing and writes no broadcast', async (_name, argv) => {
    const { code, err, port, dir } = await runCli(argv, [{ paneKey: 'a:1', behavior: repliesWithToken() }], { seed: seedRecovery(recovery(mixedRows())) });
    expect(code).toBe(2);
    expect(err).toContain(MESSAGE);
    expect(port.sends).toEqual([]);
    expect(await readBroadcasts(dir)).toEqual([]);
    expect(only(dir).status).toBe('open');
  });

  it('prints the recovery message in the broken state, and does not continue the broadcast', async () => {
    const { code, err, port } = await runCli(['broadcast', '--yes'], [{ paneKey: 'a:1', behavior: repliesWithToken() }], { seed: seedBroken() });
    expect(code).toBe(2);
    expect(err).toContain(MESSAGE);
    expect(port.sends).toEqual([]);
  });

  it('keeps the pause-run message when a pause run is open', async () => {
    const seed: Seed = async (store) => {
      await seedOpenRun(store, [agentRecord('a:1')]);
      await store.saveRecovery(recovery(mixedRows()));
    };
    const { code, err } = await runCli(['broadcast', 'hello', '--yes'], [], { seed });
    expect(code).toBe(2);
    expect(err).toContain('A pause run is open; resume or close it first.');
  });
});

describe('pause with a recovery open', () => {
  const agents = [{ paneKey: 'a:1', behavior: repliesWithToken() }];

  it('abandons the recovery with reason paused at its commit point and says so', async () => {
    const { code, err, dir } = await runCli(['pause', '--yes'], agents, { seed: seedRecovery(recovery(mixedRows(), { pid: 99 })) });
    expect(code).toBe(0);
    expect(err).toContain('recovery r1 was closed by this pause: 2 agents were not recovered yet and will not be waited for');
    const record = only(dir);
    expect(record.rows.map((r) => [r.status, r.reason])).toEqual([['abandoned', 'paused'], ['abandoned', 'paused'], ['acked', null], ['failed', 'did-not-appear']]);
    expect(record).toMatchObject({ status: 'closed', endedBy: 'abandoned' });
    expect(record).not.toHaveProperty('pid');
    expect(readPointer(dir)).toMatchObject({ kind: 'pause' });
  });

  it('says `1 agent was` for one row', async () => {
    const { err } = await runCli(['pause', '--yes'], agents, { seed: seedRecovery(recovery([row('s-a', 'pending', { reason: 'timed-out' })])) });
    expect(err).toContain('recovery r1 was closed by this pause: 1 agent was not recovered yet');
  });

  it('asks first, and a no leaves the recovery open and writes no run', async () => {
    const { code, err, questions, dir } = await runCli(['pause'], agents, { seed: seedRecovery(recovery(mixedRows())), ask: ['n'] });
    expect(code).toBe(2);
    expect(err).toContain('cancelled: nothing was sent');
    expect(questions).toHaveLength(1);
    expect(only(dir).status).toBe('open');
    expect(only(dir).rows.map((r) => r.status)).toEqual(['pending', 'pending', 'acked', 'failed']);
  });

  // A working agent whose terminal is orphaned is in the run, but nobody can be sent to: the list of sends is empty.
  const orphan = [{ paneKey: 'a:1', orphaned: true, behavior: repliesWithToken() }];

  it('asks even when the list of sends is empty, and abandons the recovery after a yes', async () => {
    const { code, questions, port, dir } = await runCli(['pause'], orphan, { seed: seedRecovery(recovery(mixedRows())), ask: ['y'] });
    expect(questions).toHaveLength(1);
    expect(port.sends).toEqual([]);
    expect(code).toBe(1);
    expect(only(dir)).toMatchObject({ status: 'closed', endedBy: 'abandoned' });
  });

  it('leaves the recovery open after a no when the list of sends is empty', async () => {
    const { code, questions, dir } = await runCli(['pause'], orphan, { seed: seedRecovery(recovery(mixedRows())), ask: ['n'] });
    expect(questions).toHaveLength(1);
    expect(code).toBe(2);
    expect(only(dir).status).toBe('open');
  });

  it('abandons both records in the broken state', async () => {
    const { code, err, dir } = await runCli(['pause', '--yes'], agents, { seed: seedBroken() });
    expect(code).toBe(0);
    expect(err).toContain('broadcast b-1 was closed by this pause');
    expect(err).toContain('recovery r1 was closed by this pause');
    expect(only(dir).status).toBe('closed');
    expect((await readBroadcasts(dir))[0]?.status).toBe('closed');
  });

  it('changes nothing when no agent can be paused, as with an open broadcast', async () => {
    const { code, out, dir } = await runCli(['pause', '--yes'], [], { seed: seedRecovery(recovery(mixedRows())) });
    expect(code).toBe(0);
    expect(out).toContain('nothing to pause');
    expect(only(dir).status).toBe('open');
  });
});

describe('resume with only a recovery open', () => {
  it('says nothing to resume, exit 0, and changes no record', async () => {
    const { code, out, dir, port } = await runCli(['resume', '--yes'], [{ paneKey: 'a:1', behavior: repliesWithToken() }], { seed: seedRecovery(recovery(mixedRows())) });
    expect(code).toBe(0);
    expect(out).toContain('nothing to resume');
    expect(port.sends).toEqual([]);
    expect(only(dir).rows.map((r) => r.status)).toEqual(['pending', 'pending', 'acked', 'failed']);
  });
});

describe('the lock held by a running recover', () => {
  // The lock names a live process (fake liveness and start time), and the open recovery record names the same process.
  const seedRunning: Seed = async (store, dir) => {
    await seedRecovery(recovery(mixedRows(), { pid: 4242, startTime: '77' }))(store, dir);
    await mkdir(storeDir(dir), { recursive: true });
    await writeFile(join(storeDir(dir), 'lock'), '4242 77\n');
  };
  const storeOptions = { pid: 999, isAlive: () => true, readStartTime: () => '77' };

  it.each([
    ['pause', ['pause', '--yes']],
    ['close', ['close']],
  ])('makes %s refuse with the usual lock message, send no signal and touch no record', async (_name, argv) => {
    const { code, err, dir, port } = await runCli(argv, [{ paneKey: 'a:1', behavior: repliesWithToken() }], { seed: seedRunning, storeOptions });
    expect(code).toBe(2);
    expect(err).toContain(LOCK_MESSAGE);
    expect(port.sends).toEqual([]);
    expect(only(dir)).toMatchObject({ status: 'open', pid: 4242 });
    expect(only(dir).rows.map((r) => r.status)).toEqual(['pending', 'pending', 'acked', 'failed']);
  });
});
