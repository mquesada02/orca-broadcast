import { describe, expect, it } from 'vitest';
import { continueText } from '../src/recover-prompt.js';
import { fakeClock, type Behavior, type FakeAgent } from './helpers/fake-orca.js';
import { GONE, parseJson, recoverRun, resultsOf, type RecoverOptions } from './helpers/recover.js';
import { readPointer, readRecoveries } from './helpers/records.js';
import { agent, rosterEntry, scanOf, T0 } from './helpers/roster.js';
import { runCli, type Seed } from './helpers/run-cli.js';
import type { RecoveryRecord, RecoveryRow } from '../src/types.js';

const TOKEN = 'tok1';
const OLD = 'Earlier reply.';
const LIVE = { bootId: 'boot-1', runtimeId: 'runtime-1' };

// An agent that answers with the ack line of the recovery, and one that answers without it.
const acks: Behavior = () => ({ state: 'done', message: `Handled it.\nORCA-ACK ${TOKEN}` });
const acksAfterSend: Behavior = ({ received }) => ({ state: 'done', message: received.length > 0 ? `Handled it.\nORCA-ACK ${TOKEN}` : OLD });
const repliesWithoutAck: Behavior = () => ({ state: 'done', message: OLD });

const live = (paneKey: string, behavior: Behavior = acksAfterSend, extra: Partial<FakeAgent> = {}): FakeAgent => agent(paneKey, { behavior, ...extra });
const appears = (paneKey: string, from: number, behavior: Behavior = acksAfterSend): FakeAgent => live(paneKey, behavior, { rowAt: (n) => n >= from, terminalAt: (n) => (n >= from ? 'ok' : 'missing') });
const holds = (sessionId: string, paneKey: string, startTime = 5) => ({ sessionId, paneKey, startTime });

// A stored row whose prompt has not been sent, and one whose prompt was sent and not acked yet.
const row = (id: string, extra: Partial<RecoveryRow> = {}): RecoveryRow => ({ ...rosterEntry(id), status: 'pending', reason: 'timed-out', promptDue: true, messagePending: true, baseline: null, ...extra });
const sent = (id: string, extra: Partial<RecoveryRow> = {}): RecoveryRow => row(id, { reason: 'no-ack', messagePending: false, baseline: OLD, ...extra });
const final = (id: string, status: RecoveryRow['status'], extra: Partial<RecoveryRow> = {}): RecoveryRow => row(id, { status, reason: null, messagePending: false, baseline: OLD, ...extra });

const record = (rows: RecoveryRow[], extra: Partial<RecoveryRecord> = {}): RecoveryRecord => ({
  id: 'r1',
  token: TOKEN,
  createdAt: '2026-02-28T23:00:00.000Z',
  status: 'open',
  snapshotKey: GONE,
  liveRuntime: LIVE,
  snapshots: [{ lastSave: '2026-02-28T23:55:00.000Z', ageMinutes: 5 }],
  rows,
  ...extra,
});

const seedRecord =
  (rec: RecoveryRecord): Seed =>
  async (store) => {
    await store.saveRecovery(rec);
    if (rec.status === 'open') await store.setCurrent('recovery', rec.id);
  };

// A re-run: the open record is the only thing on disk, so no roster exists.
const rerun = (argv: string[], agents: FakeAgent[], rec: RecoveryRecord, opts: RecoverOptions = {}) => recoverRun(['--yes', '--json', ...argv], agents, [], { seed: seedRecord(rec), newToken: () => 'tok-new', ...opts });

const only = (dir: string): RecoveryRecord => {
  const [first, ...others] = readRecoveries(dir);
  expect(others).toEqual([]);
  return first as RecoveryRecord;
};

describe('the re-run of an open recovery record', () => {
  it('is no longer refused: it continues the record with its token and closes it when every row is final', async () => {
    const rec = record([row('s-a')]);
    const { code, out, port, dir } = await rerun([], [live('new:a')], rec, { scan: scanOf(holds('s-a', 'new:a')) });
    expect(code).toBe(0);
    expect(port.sends).toEqual([{ handle: 'term_new:a', text: continueText(TOKEN, []) }]);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
    expect(only(dir)).toMatchObject({ id: 'r1', token: TOKEN, status: 'closed', endedBy: 'done' });
    expect(readPointer(dir)).toBeNull();
  });

  it('never reads the roster: no roster file is needed, and the header lines come from the record', async () => {
    const rec = record([sent('s-a')]);
    const { out, dir } = await rerun([], [live('new:a', acks)], rec, { scan: scanOf(holds('s-a', 'new:a')) });
    expect(parseJson(out).snapshots).toEqual(rec.snapshots);
    expect(parseJson(out).warnings).toEqual([]);
    expect(only(dir).snapshots).toEqual(rec.snapshots);
  });

  it('sends again only to rows that never got the prompt or whose send failed, and only waits on rows already sent', async () => {
    const rows = [row('s-a', { reason: 'waiting-permission' }), row('s-b', { reason: 'send-failed' }), sent('s-c')];
    const { out, port } = await rerun([], [live('new:a'), live('new:b'), live('new:c', repliesWithoutAck)], record(rows), { scan: scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', 6), holds('s-c', 'new:c', 7)) });
    expect(port.sends.map((s) => s.handle).sort()).toEqual(['term_new:a', 'term_new:b']);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked', 's-b': 'acked', 's-c': 'pending/still-working' });
  });

  it('never sends again to a sent row, even when its stored reason is waiting-permission', async () => {
    const { out, port } = await rerun([], [live('new:a', repliesWithoutAck)], record([sent('s-a', { reason: 'waiting-permission' })]), { scan: scanOf(holds('s-a', 'new:a')) });
    expect(port.sends).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/still-working' });
  });

  it('sends again to an unsent row whose stored reason is still-working or background', async () => {
    const rows = [row('s-a', { reason: 'still-working' }), row('s-b', { reason: 'background' })];
    const { out, port } = await rerun([], [live('new:a'), live('new:b')], record(rows), { scan: scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', 6)) });
    expect(port.sends.map((s) => s.handle).sort()).toEqual(['term_new:a', 'term_new:b']);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked', 's-b': 'acked' });
  });

  it('turns a sent row gone when no live row holds it, even when it still has a young recorded start', async () => {
    const stored = sent('s-a', { reason: 'waiting-permission', startedAt: new Date(T0 - 10_000).toISOString() });
    const { out, port } = await rerun([], [], record([stored]), { scan: scanOf() });
    expect(port.sends).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-a': 'gone/terminal-closed' });
  });

  it('counts a late ack of a sent row, with no new send', async () => {
    const { out, port } = await rerun([], [live('new:a', acks)], record([sent('s-a')]), { scan: scanOf(holds('s-a', 'new:a')) });
    expect(port.sends).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
  });

  it('marks a sent row gone, with the reason that locate gives, when no live row holds its session', async () => {
    const { code, out, dir } = await rerun([], [], record([sent('s-a')]));
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'gone/terminal-closed' });
    expect(only(dir).status).toBe('closed');
  });

  it('keeps the result of a final row', async () => {
    const rows = [final('s-a', 'acked'), final('s-b', 'failed', { reason: 'did-not-appear' })];
    const { code, out, port } = await rerun([], [], record(rows));
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked', 's-b': 'failed/did-not-appear' });
    expect(port.sends).toEqual([]);
    expect(port.starts).toEqual([]);
  });

  it('refuses with exit 2 and a clear message when the fleet restarted again, and writes nothing', async () => {
    const rec = record([row('s-a')], { liveRuntime: { bootId: 'boot-1', runtimeId: 'runtime-0' } });
    const { code, out, err, port, dir } = await rerun([], [live('new:a')], rec);
    expect(code).toBe(2);
    expect(parseJson(out)).toMatchObject({ outcome: 'error', rows: [], snapshots: [] });
    expect(err).toBe('');
    expect(parseJson(out).error).toBe('the fleet restarted again; `close` the recovery and run `recover` again');
    expect(port.scanCalls).toBe(0);
    expect(port.sends).toEqual([]);
    expect(readRecoveries(dir)).toEqual([rec]);
    expect(readPointer(dir)).toEqual({ kind: 'recovery', id: 'r1' });
  });

  it('compares only the boot IDs when a runtime ID is unknown', async () => {
    const { code } = await rerun([], [live('new:a')], record([row('s-a')], { liveRuntime: { bootId: 'boot-1', runtimeId: null } }), { scan: scanOf(holds('s-a', 'new:a')) });
    expect(code).toBe(0);
  });

  it('needs --yes without a terminal, as the first run does', async () => {
    const rec = record([row('s-a')]);
    const { code, err, port } = await runCli(['recover'], [live('new:a')], { seed: seedRecord(rec) });
    expect(code).toBe(2);
    expect(err).toContain('refusing to send without an interactive terminal');
    expect(port.listCalls).toBe(0);
  });
});

describe('filters and scope on a re-run', () => {
  const rows = () => [row('s-a', { role: 'coordinator' }), row('s-b')];
  const agents = () => [live('new:a'), live('new:b')];
  const scan = scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', 6));

  it('narrows the stored rows: the rows outside the scope keep their result, the exit code covers only the scope, the record stays open', async () => {
    const { code, out, port, dir } = await rerun(['--role', 'coordinator'], agents(), record(rows()), { scan });
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
    expect(port.sends.map((s) => s.handle)).toEqual(['term_new:a']);
    const saved = only(dir);
    expect(saved.status).toBe('open');
    expect(saved.rows.find((r) => r.sessionId === 's-b')).toMatchObject({ status: 'pending', reason: 'timed-out', messagePending: true });
    expect(readPointer(dir)).toEqual({ kind: 'recovery', id: 'r1' });
  });

  it('prints nothing to recover, exit 0, and changes nothing when the filter leaves no row', async () => {
    const rec = record(rows());
    const { code, out, port, dir } = await rerun(['--role', 'worker'], agents(), rec, { scan });
    expect(code).toBe(0);
    expect(parseJson(out)).toMatchObject({ outcome: 'nothing-to-do', rows: [] });
    expect(port.sends).toEqual([]);
    expect(readRecoveries(dir)).toEqual([rec]);
  });
});

describe('the confirmation of a re-run', () => {
  const asked = (rows: RecoveryRow[], answers: string[]) => runCli(['recover'], [live('new:a')], { seed: seedRecord(record(rows)), ask: answers, isTTY: true, clock: fakeClock(T0), configure: (p) => (p.scanAt = () => scanOf(holds('s-a', 'new:a'))) });

  it('asks nothing when the re-run only waits on rows already sent', async () => {
    const { questions, code } = await asked([sent('s-a')], []);
    expect(questions).toEqual([]);
    expect(code).toBe(1);
  });

  it('asks when a prompt is due; "no" writes nothing, leaves the record open and unchanged, shows pending/declined and exits 1', async () => {
    const rec = record([row('s-a', { reason: 'waiting-permission' })]);
    const { questions, code, out, port, dir } = await runCli(['recover'], [live('new:a')], { seed: seedRecord(rec), ask: ['n'], isTTY: true, clock: fakeClock(T0), configure: (p) => (p.scanAt = () => scanOf(holds('s-a', 'new:a'))) });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('Restart 0 agents, prompt 1 and leave 0 workers to their coordinators?');
    expect(code).toBe(1);
    expect(out).toContain('declined');
    expect(port.sends).toEqual([]);
    expect(readRecoveries(dir)).toEqual([rec]);
    expect(readPointer(dir)).toEqual({ kind: 'recovery', id: 'r1' });
  });
});

describe('a worker whose coordinator was still pending', () => {
  it('is decided again with its coordinator: the prompt lists it, and it becomes left-to-coordinator', async () => {
    const rows = [row('s-c', { role: 'coordinator', state: 'done' }), final('s-w', 'no-coordinator', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-1', reason: 'coordinator-missing' })];
    const { out, port } = await rerun([], [live('new:c')], record(rows), { scan: scanOf(holds('s-c', 'new:c')) });
    expect(port.sends).toEqual([{ handle: 'term_new:c', text: continueText(TOKEN, ['repo/tree-s-w (dispatch d-1)']) }]);
    expect(resultsOf(out)).toEqual({ 's-c': 'acked', 's-w': 'left-to-coordinator' });
  });

  it('stays no-coordinator when its coordinator is final without the list', async () => {
    const rows = [final('s-c', 'failed', { role: 'coordinator', reason: 'did-not-appear' }), final('s-w', 'no-coordinator', { role: 'worker', coordinatorSessionId: 's-c', reason: 'coordinator-missing' })];
    const { code, out } = await rerun([], [], record(rows));
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-c': 'failed/did-not-appear', 's-w': 'no-coordinator/coordinator-missing' });
  });
});

describe('the recorded-start rules on a re-run', () => {
  const startedAgo = (ms: number) => new Date(T0 - ms).toISOString();
  const awaiting = (ms: number) => row('s-a', { state: 'done', promptDue: false, messagePending: false, status: 'pending', reason: 'awaiting-start', startedAt: startedAgo(ms) });

  it('treats a start whose agent is live at the first listing as restarted, and starts nothing', async () => {
    const { code, out, port, dir } = await rerun([], [live('new:a')], record([awaiting(30_000)]), { scan: scanOf(holds('s-a', 'new:a')) });
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted' });
    expect(port.starts).toEqual([]);
    expect(only(dir).status).toBe('closed');
  });

  it('waits for a start that is just under 2 minutes old, and restarts nothing when the agent appears', async () => {
    const scan = (n: number) => (n >= 2 ? scanOf(holds('s-a', 'new:a')) : scanOf());
    const { out, port } = await rerun([], [appears('new:a', 2)], record([awaiting(119_999)]), { scan });
    expect(port.starts).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted' });
  });

  it('drops a start that is exactly 2 minutes old and starts the agent again', async () => {
    const { out, port } = await rerun(['--timeout', '5s'], [], record([awaiting(120_000)]));
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/did-not-appear' });
  });

  it('drops the start in the same run when it turns 2 minutes old during the wait', async () => {
    const { port } = await rerun(['--timeout', '10s'], [], record([awaiting(119_000)]));
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
  });

  it('keeps the row pending, the start stored and the record open when --timeout ends while the start is under 2 minutes old', async () => {
    const rec = record([awaiting(60_000)]);
    const { code, out, port, dir } = await rerun(['--timeout', '5s'], [], rec);
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/awaiting-start' });
    expect(port.starts).toEqual([]);
    const saved = only(dir);
    expect(saved.status).toBe('open');
    expect(saved.rows[0]?.startedAt).toBe(startedAgo(60_000));
    expect(saved.pid).toBeUndefined();
  });

  it('resumes after an interruption between a recorded start and the appearance of the agent', async () => {
    // What a run that was interrupted right after its start leaves on disk: the start is recorded and the pid is cleared.
    const interrupted = record([row('s-a', { status: 'pending', reason: 'awaiting-start', startedAt: startedAgo(10_000) })]);
    const scan = (n: number) => (n >= 2 ? scanOf(holds('s-a', 'new:a')) : scanOf());
    const { out, port } = await rerun([], [appears('new:a', 2)], interrupted, { scan });
    expect(port.starts).toEqual([]);
    expect(port.sends).toHaveLength(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
  });
});

describe('the extra workers of a retake coordinator', () => {
  it('are listed in the prompt that a re-run sends', async () => {
    const coordinator = row('s-c', { role: 'coordinator', state: 'done', extraWorkers: [{ repo: 'repo', worktree: 'tree-s-x', dispatchId: 'd-x' }] });
    const worker = final('s-w', 'no-coordinator', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-w', reason: 'coordinator-missing' });
    const { port } = await rerun([], [live('new:c')], record([coordinator, worker]), { scan: scanOf(holds('s-c', 'new:c')) });
    expect(port.sends[0]?.text).toBe(continueText(TOKEN, ['repo/tree-s-w (dispatch d-w)', 'repo/tree-s-x (dispatch d-x)']));
  });
});

