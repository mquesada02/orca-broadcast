import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { continueText } from '../src/recover-prompt.js';
import { createRecordStore } from '../src/store.js';
import { fakeClock, tempStateDir, type Behavior, type FakeAgent } from './helpers/fake-orca.js';
import { doneEntry, GONE, parseJson, recoverRun, resultsOf, type RecoverOptions } from './helpers/recover.js';
import { readPointer, readRecoveries, storeDir } from './helpers/records.js';
import { agent, rosterEntry, rosterSnapshot, scanOf, seedRosters, T0 } from './helpers/roster.js';
import { runCli, type Seed } from './helpers/run-cli.js';
import type { RecoveryRecord, RecoveryRow, RosterEntry } from '../src/types.js';

const OLD = 'Earlier reply.';
const LIVE = { bootId: 'boot-1', runtimeId: 'runtime-1' };
const TOKEN = 'tok-new';

const acks: Behavior = ({ received }) => ({ state: 'done', message: received.length > 0 ? `Handled it.\nORCA-ACK ${TOKEN}` : OLD });
const live = (paneKey: string, behavior: Behavior = acks, extra: Partial<FakeAgent> = {}): FakeAgent => agent(paneKey, { behavior, ...extra });
const appears = (paneKey: string, from: number): FakeAgent => live(paneKey, acks, { rowAt: (n) => n >= from, terminalAt: (n) => (n >= from ? 'ok' : 'missing') });
const holds = (sessionId: string, paneKey: string, startTime = 5) => ({ sessionId, paneKey, startTime });

// A row of an earlier record, with the result it ended with.
const earlierRow = (entry: RosterEntry, status: RecoveryRow['status'], reason: RecoveryRow['reason'] = null, extra: Partial<RecoveryRow> = {}): RecoveryRow => ({ ...entry, status, reason, promptDue: entry.state !== 'done', messagePending: false, baseline: OLD, ...extra });

const closed = (rows: RecoveryRow[], extra: Partial<RecoveryRecord> = {}): RecoveryRecord => ({
  id: 'r-old',
  token: 'tok-old',
  createdAt: '2026-03-01T00:00:00.000Z',
  status: 'closed',
  endedBy: 'done',
  snapshotKey: GONE,
  liveRuntime: LIVE,
  snapshots: [],
  rows,
  ...extra,
});

// The roster of the runtime that is gone, and the earlier record, on disk.
const seeded =
  (entries: RosterEntry[], rec: RecoveryRecord): Seed =>
  async (store) => {
    await seedRosters(rosterSnapshot(GONE, entries))(store);
    await store.saveRecovery(rec);
  };

const retake = (agents: FakeAgent[], entries: RosterEntry[], rec: RecoveryRecord, { argv = [], ...opts }: RecoverOptions & { argv?: string[] } = {}) =>
  recoverRun(['--yes', '--json', ...argv], agents, entries, { seed: seeded(entries, rec), newToken: () => TOKEN, ...opts });

const bySession = (records: RecoveryRecord[], id: string): RecoveryRecord => records.find((r) => r.id === id) as RecoveryRecord;

describe('loadNewestClosedRecovery', () => {
  const record = (id: string, createdAt: string, extra: Partial<RecoveryRecord> = {}): RecoveryRecord => ({ ...closed([], { id, createdAt }), ...extra });

  it('returns the newest record that closed by itself, never an open or an abandoned one', async () => {
    const dir = await tempStateDir();
    const store = createRecordStore(dir);
    expect(await store.loadNewestClosedRecovery()).toBeNull();
    await store.saveRecovery(record('a', '2026-03-01T00:00:00.000Z'));
    await store.saveRecovery(record('b', '2026-03-02T00:00:00.000Z'));
    await store.saveRecovery(record('c', '2026-03-03T00:00:00.000Z', { endedBy: 'abandoned' }));
    await store.saveRecovery(record('d', '2026-03-04T00:00:00.000Z', { status: 'open' }));
    expect((await store.loadNewestClosedRecovery())?.id).toBe('b');
  });

  it('sends an equal time to the greater id, and keeps the extra workers of a coordinator row', async () => {
    const dir = await tempStateDir();
    const store = createRecordStore(dir);
    const extra = { repo: 'repo', worktree: 'tree-x', dispatchId: 'd-x' };
    await store.saveRecovery(record('a', '2026-03-01T00:00:00.000Z'));
    await store.saveRecovery(record('b', '2026-03-01T00:00:00.000Z', { rows: [{ ...earlierRow(rosterEntry('s-c', { role: 'coordinator' }), 'acked'), extraWorkers: [extra] }] }));
    const newest = await store.loadNewestClosedRecovery();
    expect(newest?.id).toBe('b');
    expect(newest?.rows[0]?.extraWorkers).toEqual([extra]);
  });
});

describe('recovering again from the same restart', () => {
  it('takes only the failed, gone and no-coordinator rows, under a new token, and leaves the earlier record as it was', async () => {
    const [a, b, c, z] = [rosterEntry('s-a'), doneEntry('s-b'), rosterEntry('s-c'), rosterEntry('s-z')];
    const old = closed([earlierRow(a, 'acked'), earlierRow(b, 'failed', 'start-failed'), earlierRow(c, 'gone', 'terminal-closed')]);
    const scan = (n: number) => (n >= 3 ? scanOf(holds('s-c', 'new:c'), holds('s-b', 'new:b', 6)) : scanOf(holds('s-c', 'new:c')));
    const { code, out, port, dir } = await retake([live('new:c'), appears('new:b', 3)], [a, b, c, z], old, { scan });
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-b': 'restarted', 's-c': 'acked' });
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-b']);
    expect(port.sends).toEqual([{ handle: 'term_new:c', text: continueText(TOKEN, []) }]);
    const records = readRecoveries(dir);
    expect(records).toHaveLength(2);
    expect(bySession(records, 'r-old')).toEqual(old);
    const fresh = records.find((r) => r.id !== 'r-old') as RecoveryRecord;
    expect(fresh).toMatchObject({ token: TOKEN, status: 'closed', endedBy: 'done', snapshotKey: GONE, liveRuntime: LIVE });
    expect(fresh.rows.map((r) => r.sessionId).sort()).toEqual(['s-b', 's-c']);
  });

  it('prints nothing to recover, exit 0, when no row can be taken again', async () => {
    const a = rosterEntry('s-a');
    const { code, out, dir } = await retake([live('new:a')], [a], closed([earlierRow(a, 'acked')]), { scan: scanOf(holds('s-a', 'new:a')) });
    expect(code).toBe(0);
    expect(parseJson(out)).toMatchObject({ outcome: 'nothing-to-do', rows: [] });
    expect(parseJson(out).snapshots).toHaveLength(1);
    expect(readRecoveries(dir)).toHaveLength(1);
  });

  it('is a first recovery when the earlier record was abandoned', async () => {
    const [a, b] = [doneEntry('s-a'), doneEntry('s-b')];
    const { out } = await retake([live('new:a'), live('new:b')], [a, b], closed([earlierRow(a, 'failed', 'start-failed')], { endedBy: 'abandoned' }), { scan: scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', 6)) });
    expect(resultsOf(out)).toEqual({ 's-a': 'restored', 's-b': 'restored' });
  });

  it('is a first recovery when the live runtime changed since the earlier record', async () => {
    const [a, b] = [doneEntry('s-a'), doneEntry('s-b')];
    const old = closed([earlierRow(a, 'failed', 'start-failed')], { liveRuntime: { bootId: 'boot-1', runtimeId: 'runtime-0' } });
    const { out } = await retake([live('new:a'), live('new:b')], [a, b], old, { scan: scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', 6)) });
    expect(resultsOf(out)).toEqual({ 's-a': 'restored', 's-b': 'restored' });
  });

  it('is a first recovery when the earlier record used another snapshot', async () => {
    const [a, b] = [doneEntry('s-a'), doneEntry('s-b')];
    const old = closed([earlierRow(a, 'failed', 'start-failed')], { snapshotKey: { bootId: 'boot-0', runtimeId: 'runtime-9' } });
    const { out } = await retake([live('new:a'), live('new:b')], [a, b], old, { scan: scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', 6)) });
    expect(resultsOf(out)).toEqual({ 's-a': 'restored', 's-b': 'restored' });
  });

  it('asks once, and "no" writes no record, leaves the earlier record as it was and exits 1 with the rows pending/declined', async () => {
    const b = doneEntry('s-b');
    const old = closed([earlierRow(b, 'failed', 'start-failed')]);
    const { code, out, questions, port, dir } = await runCli(['recover'], [], { seed: seeded([b], old), ask: ['n'], isTTY: true, clock: fakeClock(T0), configure: (p) => (p.scanAt = () => scanOf()) });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('Restart 1 agents, prompt 0 and leave 0 workers to their coordinators?');
    expect(code).toBe(1);
    expect(out).toContain('declined');
    expect(port.starts).toEqual([]);
    expect(readRecoveries(dir)).toEqual([old]);
  });

  it('refuses, naming the file, when a record in recoveries/ cannot be read', async () => {
    const b = doneEntry('s-b');
    const seed: Seed = async (store, dir) => {
      await seeded([b], closed([]))(store, dir);
      await writeFile(join(storeDir(dir), 'recoveries', 'broken.json'), 'not json');
    };
    const { code, err } = await recoverRun(['--yes'], [], [b], { seed });
    expect(code).toBe(2);
    expect(err).toContain('unreadable record');
    expect(err).toContain('broken.json');
  });

  it('applies the filters to the retaken rows', async () => {
    const [a, c] = [doneEntry('s-a', { role: 'coordinator' }), doneEntry('s-c')];
    const old = closed([earlierRow(a, 'failed', 'start-failed'), earlierRow(c, 'failed', 'start-failed')]);
    const { out } = await retake([live('new:a'), live('new:c')], [a, c], old, { scan: scanOf(holds('s-a', 'new:a'), holds('s-c', 'new:c', 6)), argv: ['--role', 'coordinator'] });
    expect(resultsOf(out)).toEqual({ 's-a': 'restored' });
  });
});

describe('a retaken worker and its coordinator', () => {
  const coordinator = rosterEntry('s-c', { role: 'coordinator', state: 'done' });
  const worker = (id: string, dispatchId: string) => rosterEntry(id, { role: 'worker', coordinatorSessionId: 's-c', dispatchId });

  it('brings in its live coordinator with the full list: the retaken worker has a row, an earlier left worker has none, and the record keeps the list', async () => {
    const [w, w2] = [worker('s-w', 'd-1'), worker('s-w2', 'd-2')];
    const old = closed([earlierRow(coordinator, 'acked'), earlierRow(w, 'no-coordinator', 'coordinator-missing'), earlierRow(w2, 'left-to-coordinator')]);
    const { code, out, port, dir } = await retake([live('new:c')], [coordinator, w, w2], old, { scan: scanOf(holds('s-c', 'new:c')) });
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-c': 'acked', 's-w': 'left-to-coordinator' });
    expect(port.sends).toEqual([{ handle: 'term_new:c', text: continueText(TOKEN, ['repo/tree-s-w (dispatch d-1)', 'repo/tree-s-w2 (dispatch d-2)']) }]);
    const fresh = readRecoveries(dir).find((r) => r.id !== 'r-old') as RecoveryRecord;
    expect(fresh.rows.find((r) => r.sessionId === 's-c')?.extraWorkers).toEqual([{ repo: 'repo', worktree: 'tree-s-w2', dispatchId: 'd-2' }]);
    expect(fresh.rows.some((r) => r.sessionId === 's-w2')).toBe(false);
  });

  it('does not list an earlier left worker that is live again', async () => {
    const [w, w2] = [worker('s-w', 'd-1'), worker('s-w2', 'd-2')];
    const old = closed([earlierRow(coordinator, 'acked'), earlierRow(w, 'no-coordinator', 'coordinator-missing'), earlierRow(w2, 'left-to-coordinator')]);
    const { port } = await retake([live('new:c'), live('new:w2')], [coordinator, w, w2], old, { scan: scanOf(holds('s-c', 'new:c'), holds('s-w2', 'new:w2', 6)) });
    expect(port.sends.find((s) => s.handle === 'term_new:c')?.text).toBe(continueText(TOKEN, ['repo/tree-s-w (dispatch d-1)']));
  });

  it('does not bring in a coordinator whose list would be empty', async () => {
    const w = rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-1', state: 'done' });
    const old = closed([earlierRow(coordinator, 'acked'), earlierRow(w, 'no-coordinator', 'coordinator-missing')]);
    const { out, port } = await retake([live('new:c'), live('new:w')], [coordinator, w], old, { scan: scanOf(holds('s-c', 'new:c'), holds('s-w', 'new:w', 6)) });
    expect(resultsOf(out)).toEqual({ 's-w': 'restored' });
    expect(port.sends).toEqual([]);
  });

  it('does not bring in a coordinator that is not live: its worker has no coordinator', async () => {
    const w = worker('s-w', 'd-1');
    const old = closed([earlierRow(coordinator, 'acked'), earlierRow(w, 'no-coordinator', 'coordinator-missing')]);
    const { out, port } = await retake([], [coordinator, w], old);
    expect(resultsOf(out)).toEqual({ 's-w': 'no-coordinator/coordinator-missing' });
    expect(port.starts).toEqual([]);
  });

  it('leaves a retaken worker with no coordinator when the filters exclude its coordinator', async () => {
    const w = rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-1' });
    const old = closed([earlierRow(coordinator, 'acked'), earlierRow(w, 'no-coordinator', 'coordinator-missing')]);
    const { out, port } = await retake([live('new:c')], [coordinator, w], old, { scan: scanOf(holds('s-c', 'new:c')), argv: ['--role', 'worker'] });
    expect(resultsOf(out)).toEqual({ 's-w': 'no-coordinator/coordinator-filtered' });
    expect(port.sends).toEqual([]);
  });
});

describe('the recorded-start rules on a retake', () => {
  const entry = doneEntry('s-a');
  const failedStart = (ms: number) => closed([earlierRow(entry, 'failed', 'did-not-appear', { startedAt: new Date(T0 - ms).toISOString() })]);

  it('waits for a start under 2 minutes old, and the new record stays open when --timeout ends first', async () => {
    const { code, out, port, dir } = await retake([], [entry], failedStart(30_000), { argv: ['--timeout', '5s'] });
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/awaiting-start' });
    expect(port.starts).toEqual([]);
    const fresh = readRecoveries(dir).find((r) => r.id !== 'r-old') as RecoveryRecord;
    expect(fresh.status).toBe('open');
    expect(fresh.rows[0]?.startedAt).toBeTypeOf('string');
    expect(readPointer(dir)).toEqual({ kind: 'recovery', id: fresh.id });
  });

  it('classifies the agent again when the start is 2 minutes old, and calls it restarted when its agent is live', async () => {
    const dropped = await retake([], [entry], failedStart(120_000), { argv: ['--timeout', '5s'] });
    expect(dropped.port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    const liveNow = await retake([live('new:a')], [entry], failedStart(30_000), { scan: scanOf(holds('s-a', 'new:a')) });
    expect(resultsOf(liveNow.out)).toEqual({ 's-a': 'restarted' });
    expect(liveNow.port.starts).toEqual([]);
  });
});
