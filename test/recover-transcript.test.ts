import { describe, expect, it } from 'vitest';
import { entryOf } from '../src/recover-record.js';
import type { RecoveryRecord, RecoveryRow, TranscriptIdentity, TranscriptMark } from '../src/types.js';
import { type Behavior, type FakeAgent, type FakeOrca } from './helpers/fake-orca.js';
import { GONE, parseJson, recoverRun, resultsOf, type RecoverOptions } from './helpers/recover.js';
import { readRecoveries } from './helpers/records.js';
import { agent, rosterEntry, scanOf } from './helpers/roster.js';
import type { Seed } from './helpers/run-cli.js';

const TOKEN = 'tok1';
const ACK = `ORCA-ACK ${TOKEN}`;
const OLD = 'Earlier reply.';
const SECRET = 'SECRET-TEXT-IN-A-TRANSCRIPT';
const newToken = () => TOKEN;

const identityOf = (sessionId: string, pid = 10): TranscriptIdentity => ({ sessionId, cwd: `/work/tree-${sessionId}`, configDir: '/cfg', pid, startTime: 5 });
const holds = (sessionId: string, paneKey: string, withIdentity = true, pid = 10) => ({ sessionId, paneKey, startTime: 5, ...(withIdentity ? { cwd: `/work/tree-${sessionId}`, transcript: identityOf(sessionId, pid) } : {}) });

/** Done with an old reply before the prompt; after it, a later turn whose last reply has no ack line (a wake-up turn hid it). */
const wokenAfterSend: Behavior = ({ received }) => ({ state: 'done', message: received.length > 0 ? 'Back at work.' : OLD });
/** After the prompt the agent sits on a permission prompt. */
const waitingAfterSend: Behavior = ({ received }) => (received.length > 0 ? { state: 'waiting', message: null } : { state: 'done', message: OLD });
/** An agent whose last reply is a later turn without the ack line, whatever it received in this run (for a row sent in an earlier run). */
const alwaysWoken: Behavior = () => ({ state: 'done', message: 'Back at work.' });
/** An agent whose last reply has the ack line, whatever it received in this run (for a row sent in an earlier run). */
const alwaysAcks: Behavior = () => ({ state: 'done', message: `Handled it.\n${ACK}` });
const acksByLastReply: Behavior = ({ received }) => ({ state: 'done', message: received.length > 0 ? `Handled it.\n${ACK}` : OLD });

const live = (paneKey: string, behavior: Behavior = wokenAfterSend, extra: Partial<FakeAgent> = {}): FakeAgent => agent(paneKey, { behavior, ...extra });
const appears = (paneKey: string, from: number, behavior: Behavior = wokenAfterSend): FakeAgent => live(paneKey, behavior, { rowAt: (n) => n >= from, terminalAt: (n) => (n >= from ? 'ok' : 'missing') });

/** A transcript for the session; `onSend` edits it right after the offset was taken (the fake sends after `onSend`). */
const transcript = (sessionId: string, onSend: (port: FakeOrca) => void) => (port: FakeOrca) => {
  port.transcript(sessionId);
  port.onSend = () => onSend(port);
};

const run = (argv: string[], agents: FakeAgent[], entries: ReturnType<typeof rosterEntry>[], opts: RecoverOptions) => recoverRun(['--yes', '--json', ...argv], agents, entries, { newToken, ...opts });

const only = (dir: string): RecoveryRecord => {
  const [record, ...others] = readRecoveries(dir);
  expect(others).toEqual([]);
  return record as RecoveryRecord;
};
const rowOf = (dir: string, sessionId: string): RecoveryRow => only(dir).rows.find((r) => r.sessionId === sessionId) as RecoveryRow;

const ackThenWake = (sessionId: string) => (port: FakeOrca) => void port.transcript(sessionId).reply(`Done.\n${ACK}`).reply('Back at work.');

describe('recover: the transcript proof', () => {
  it('acks a started and prompted agent whose ack reply was followed by a wake-up turn, with the identity from the rescan', async () => {
    const scan = (n: number) => (n >= 3 ? scanOf(holds('s-a', 'new:a')) : scanOf());
    const { code, out, dir } = await run([], [appears('new:a', 3)], [rosterEntry('s-a')], { scan, configure: transcript('s-a', ackThenWake('s-a')) });
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
    expect(rowOf(dir, 's-a').transcript).toMatchObject({ identity: identityOf('s-a'), position: 0 });
  });

  it('acks a restored agent the same way', async () => {
    const { code, out, dir } = await run([], [live('new:a')], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a')), configure: transcript('s-a', ackThenWake('s-a')) });
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
    expect(rowOf(dir, 's-a').transcript?.identity).toEqual(identityOf('s-a'));
  });

  it('does not ack an agent whose token line is only in a mid-turn entry', async () => {
    const onSend = (port: FakeOrca) => void port.transcript('s-a').ignored(ACK).reply('Back at work.');
    const { code, out } = await run(['--timeout', '6s'], [live('new:a')], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a')), configure: transcript('s-a', onSend) });
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/no-ack' });
  });

  it('keeps an ack after the transcript is removed, while another row still waits', async () => {
    const entries = [rosterEntry('s-a'), rosterEntry('s-b')];
    let port: FakeOrca | undefined;
    let sleeps = 0;
    // The first sleep follows the tick that sent the prompts; the second follows the tick that read the proof. The removal comes after that.
    const { out } = await run(['--timeout', '6s'], [live('new:a'), live('new:b')], entries, {
      scan: scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', false)),
      configure: (p) => {
        port = p;
        transcript('s-a', ackThenWake('s-a'))(p);
      },
      onSleep: () => {
        sleeps += 1;
        if (sleeps >= 2) port?.transcript('s-a').remove();
      },
    });
    expect(resultsOf(out)).toEqual({ 's-a': 'acked', 's-b': 'pending/no-ack' });
  });

  it('proves as today when the scan names no transcript', async () => {
    const wake = await run(['--timeout', '6s'], [live('new:a')], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a', false)), configure: transcript('s-a', ackThenWake('s-a')) });
    expect(resultsOf(wake.out)).toEqual({ 's-a': 'pending/no-ack' });
    expect(rowOf(wake.dir, 's-a').transcript).toBeUndefined();
    const last = await run([], [live('new:a', acksByLastReply)], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a', false)) });
    expect(resultsOf(last.out)).toEqual({ 's-a': 'acked' });
  });

  it('adds no session scan', async () => {
    const withId = await run([], [live('new:a')], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a')), configure: transcript('s-a', ackThenWake('s-a')) });
    const without = await run([], [live('new:a', acksByLastReply)], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a', false)) });
    expect(withId.port.scanCalls).toBe(without.port.scanCalls);
  });

  describe('on a permission prompt after the prompt', () => {
    it('acks with a transcript reply that has the token line', async () => {
      const { out } = await run([], [live('new:a', waitingAfterSend)], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a')), configure: transcript('s-a', (p) => void p.transcript('s-a').reply(`Done.\n${ACK}`)) });
      expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
    });

    it('does not ack without the token line', async () => {
      const { out } = await run(['--timeout', '6s'], [live('new:a', waitingAfterSend)], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a')), configure: transcript('s-a', (p) => void p.transcript('s-a').reply('Done.')) });
      expect(resultsOf(out)).toEqual({ 's-a': 'pending/waiting-permission' });
    });
  });
});

// A stored row whose prompt was not accepted, the record it lives in, and a re-run.
const row = (id: string, extra: Partial<RecoveryRow> = {}): RecoveryRow => ({ ...rosterEntry(id), status: 'pending', reason: 'send-failed', promptDue: true, messagePending: true, baseline: null, ...extra });
const seedRecord =
  (rows: RecoveryRow[]): Seed =>
  async (store) => {
    const record: RecoveryRecord = { id: 'r1', token: TOKEN, createdAt: '2026-02-28T23:00:00.000Z', status: 'open', snapshotKey: GONE, liveRuntime: { bootId: 'boot-1', runtimeId: 'runtime-1' }, snapshots: [{ lastSave: '2026-02-28T23:55:00.000Z', ageMinutes: 5 }], rows };
    await store.saveRecovery(record);
    await store.setCurrent('recovery', record.id);
  };
const rerun = (rows: RecoveryRow[], agents: FakeAgent[], opts: RecoverOptions = {}) => recoverRun(['--yes', '--json', '--timeout', '6s'], agents, [], { seed: seedRecord(rows), newToken, ...opts });

/** The mark of a transcript at its first read (position 0, its file id), for a stored row. */
const markOf = (port: FakeOrca, sessionId: string, identity: TranscriptIdentity, position = 0): TranscriptMark => {
  const read = port.transcript(sessionId).read(0, null, []);
  if (read.kind !== 'ok') throw new Error('no transcript');
  return { identity, position, fileId: read.fileId };
};

describe('recover: a re-run', () => {
  it('keeps the first identity, offset and file id when it sends again, and a reply after the first mark proves the row', async () => {
    // The stored row holds the mark of the first run (pid 10), taken before the transcript got its replies; the re-run's scan names pid 11.
    const first: TranscriptMark = { identity: identityOf('s-a', 10), position: 0, fileId: 'gen-1' };
    const { out, dir } = await rerun([row('s-a', { transcript: first })], [live('new:a')], { scan: scanOf(holds('s-a', 'new:a', true, 11)), configure: ackThenWake('s-a') });
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
    expect(rowOf(dir, 's-a').transcript).toEqual(first);
  });

  it('takes the mark at the first send that has an identity, and a reply to the earlier prompt is not proven by the transcript', async () => {
    const { out, dir } = await rerun([row('s-a')], [live('new:a')], { scan: scanOf(holds('s-a', 'new:a')), configure: ackThenWake('s-a') });
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/no-ack' });
    expect(rowOf(dir, 's-a').transcript).toMatchObject({ identity: identityOf('s-a'), position: 2 });
  });

  it('uses the last reply for an older record row that has no mark', async () => {
    const stored = row('s-a', { reason: 'no-ack', messagePending: false, baseline: OLD });
    const wake = await rerun([stored], [live('new:a', alwaysWoken)], { scan: scanOf(holds('s-a', 'new:a')), configure: ackThenWake('s-a') });
    expect(resultsOf(wake.out)).toEqual({ 's-a': 'pending/no-ack' });
    expect(rowOf(wake.dir, 's-a').transcript).toBeUndefined();
    const last = await rerun([stored], [live('new:a', alwaysAcks)], { scan: scanOf(holds('s-a', 'new:a')) });
    expect(resultsOf(last.out)).toEqual({ 's-a': 'acked' });
  });

  describe('falls back to the last reply when the transcript is missing', () => {
    const sentRow = (mark: TranscriptMark) => row('s-a', { reason: 'no-ack', messagePending: false, baseline: OLD, transcript: mark });
    const cases: [string, (port: FakeOrca) => void, number][] = [
      ['the file is gone', (p) => void p.transcript('s-a').remove(), 0],
      ['the file shrank', (p) => void p.transcript('s-a').shrink(5), 5],
      ['the file was replaced', (p) => void p.transcript('s-a').replace(), 0],
      ['the session has no transcript for the identity', () => {}, 0],
    ];
    it.each(cases)('%s', async (_name, change, position) => {
      let mark: TranscriptMark = { identity: identityOf('s-a'), position, fileId: 'gen-1' };
      const seed: Seed = (store, d) => seedRecord([sentRow(mark)])(store, d);
      const { out } = await rerun([], [live('new:a', alwaysWoken)], {
        scan: scanOf(holds('s-a', 'new:a')),
        seed,
        configure: (port) => {
          if (_name !== 'the session has no transcript for the identity') {
            ackThenWake('s-a')(port);
            mark = markOf(port, 's-a', identityOf('s-a'), position);
          }
          change(port);
        },
      });
      expect(resultsOf(out)).toEqual({ 's-a': 'pending/no-ack' });
    });
  });
});

describe('recover: the record', () => {
  it('holds the mark and no transcript text, and a roster entry made from a row has no mark', async () => {
    const onSend = (port: FakeOrca) => void port.transcript('s-a').reply(`${SECRET}\n${ACK}`).reply(`${SECRET} again`);
    const { out, dir } = await run([], [live('new:a')], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a')), configure: transcript('s-a', onSend) });
    expect(out).not.toContain(SECRET);
    const saved = only(dir);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(parseJson(out).record?.rows[0]?.transcript).toBeDefined();
    const stored = saved.rows[0] as RecoveryRow;
    expect(stored.transcript).toBeDefined();
    expect('transcript' in entryOf(stored)).toBe(false);
  });
});
