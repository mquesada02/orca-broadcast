import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { continueText } from '../src/recover-prompt.js';
import { fakeClock, type Behavior } from './helpers/fake-orca.js';
import { doneEntry, parseJson, recoverRun, resultsOf, type RecoverOptions } from './helpers/recover.js';
import { readPointer, readRecoveries } from './helpers/records.js';
import { agent, rosterEntry, scanOf, T0 } from './helpers/roster.js';
import type { RecoveryRecord, RosterEntry } from '../src/types.js';
import type { FakeAgent } from './helpers/fake-orca.js';

const TOKEN = 'tok1';
const OLD = 'Earlier reply.';

// An agent that has not answered yet, and that answers with the ack line once it received a prompt.
const acks: Behavior = ({ received }) => (received.length > 0 ? { state: 'done', message: `Handled it.\nORCA-ACK ${TOKEN}` } : { state: 'done', message: OLD });
// An agent that answers, but without the ack line.
const repliesWithoutAck: Behavior = ({ received }) => ({ state: 'done', message: received.length > 0 ? 'I did something.' : OLD });
const stillWorking: Behavior = () => ({ state: 'working', message: null });
const waiting: Behavior = () => ({ state: 'waiting', message: OLD });

const live = (paneKey: string, behavior: Behavior = acks, extra: Partial<FakeAgent> = {}): FakeAgent => agent(paneKey, { behavior, ...extra });
// An agent whose row and terminal exist from this listing number on.
const appears = (paneKey: string, from: number, behavior: Behavior = acks): FakeAgent => live(paneKey, behavior, { rowAt: (n) => n >= from, terminalAt: (n) => (n >= from ? 'ok' : 'missing') });
const holds = (sessionId: string, paneKey: string, startTime = 5) => ({ sessionId, paneKey, startTime });
const run = (agents: FakeAgent[], entries: RosterEntry[], scan: RecoverOptions['scan'], extra: string[] = []) => recoverRun(['--yes', '--json', ...extra], agents, entries, { scan, newToken: () => TOKEN });
const sentTo = (port: { sends: { handle: string; text: string }[] }) => port.sends.map((s) => s.handle);
const only = (dir: string): RecoveryRecord => {
  const [record, ...others] = readRecoveries(dir);
  expect(others).toEqual([]);
  return record as RecoveryRecord;
};

describe('who is prompted, and with what', () => {
  it('sends the exact text to a restored working agent by the pane that holds its session, and an ack ends the recovery', async () => {
    const { code, out, port, dir } = await run([live('new:a')], [rosterEntry('s-a', { paneKey: 'old:a' })], scanOf(holds('s-a', 'new:a')));
    expect(code).toBe(0);
    expect(port.sends).toEqual([{ handle: 'term_new:a', text: continueText(TOKEN, []) }]);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
    expect(port.starts).toEqual([]);
    const record = only(dir);
    expect(record).toMatchObject({ status: 'closed', endedBy: 'done', token: TOKEN });
    expect(record.pid).toBeUndefined();
    expect(readPointer(dir)).toBeNull();
  });

  it('prompts a waiting agent, and does not prompt a done one', async () => {
    const entries = [rosterEntry('s-w', { state: 'waiting' }), doneEntry('s-d')];
    const { out, port } = await run([live('new:w'), live('new:d')], entries, scanOf(holds('s-w', 'new:w'), holds('s-d', 'new:d', 6)));
    expect(resultsOf(out)).toEqual({ 's-w': 'acked', 's-d': 'restored' });
    expect(sentTo(port)).toEqual(['term_new:w']);
  });

  it('prompts a restored and a restarted agent with the same text', async () => {
    const entries = [rosterEntry('s-a'), rosterEntry('s-b')];
    const scan = (n: number) => (n >= 3 ? scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', 6)) : scanOf(holds('s-a', 'new:a')));
    const { out, port } = await run([live('new:a'), appears('new:b', 3)], entries, scan);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked', 's-b': 'acked' });
    expect(new Set(port.sends.map((s) => s.text))).toEqual(new Set([continueText(TOKEN, [])]));
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-b']);
  });

  it('prompts a done coordinator that has a missing worker, with the worker in the text; the worker is left to it and is never started', async () => {
    const entries = [doneEntry('s-c', { role: 'coordinator' }), rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-1' })];
    const { code, out, port } = await run([live('new:c')], entries, scanOf(holds('s-c', 'new:c')));
    expect(code).toBe(0);
    expect(port.sends).toEqual([{ handle: 'term_new:c', text: continueText(TOKEN, ['repo/tree-s-w (dispatch d-1)']) }]);
    expect(resultsOf(out)).toEqual({ 's-c': 'acked', 's-w': 'left-to-coordinator' });
    expect(port.starts).toEqual([]);
  });

  it('sends a restored worker its own prompt, and a held worker is failed and not in the list of its coordinator', async () => {
    const entries = [
      doneEntry('s-c', { role: 'coordinator' }),
      rosterEntry('s-wr', { role: 'worker', coordinatorSessionId: 's-c' }),
      rosterEntry('s-wh', { role: 'worker', coordinatorSessionId: 's-c' }),
      rosterEntry('s-wm', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-m' }),
    ];
    const scan = scanOf(holds('s-c', 'new:c'), holds('s-wr', 'new:r', 6), { sessionId: 's-wh', paneKey: null });
    // The re-check of the held worker takes the first 60 seconds of the timeout.
    const { out, port } = await run([live('new:c'), live('new:r')], entries, scan, ['--timeout', '90s']);
    expect(port.sends.find((s) => s.handle === 'term_new:c')?.text).toBe(continueText(TOKEN, ['repo/tree-s-wm (dispatch d-m)']));
    expect(port.sends.find((s) => s.handle === 'term_new:r')?.text).toBe(continueText(TOKEN, []));
    expect(resultsOf(out)).toEqual({ 's-c': 'acked', 's-wr': 'acked', 's-wh': 'failed/session-held', 's-wm': 'left-to-coordinator' });
  });

  it('sends coordinators before the other agents of a tick', async () => {
    const entries = [rosterEntry('s-a'), rosterEntry('s-c', { role: 'coordinator' }), rosterEntry('s-b')];
    const scan = scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', 6), holds('s-c', 'new:c', 7));
    const { port } = await run([live('new:a'), live('new:b'), live('new:c')], entries, scan);
    expect(sentTo(port)).toEqual(['term_new:c', 'term_new:a', 'term_new:b']);
  });

  it('does not hold an agent that is due back for a coordinator that has not appeared yet', async () => {
    const entries = [rosterEntry('s-a'), rosterEntry('s-c', { role: 'coordinator' })];
    const scan = (n: number) => (n >= 4 ? scanOf(holds('s-a', 'new:a'), holds('s-c', 'new:c', 7)) : scanOf(holds('s-a', 'new:a')));
    const { out, port } = await run([live('new:a'), appears('new:c', 4)], entries, scan);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked', 's-c': 'acked' });
    expect(sentTo(port)).toEqual(['term_new:a', 'term_new:c']);
  });

  it('a full crash recovery: a missing coordinator and a missing agent restart, appear, are prompted coordinator first, and ack', async () => {
    const entries = [
      rosterEntry('s-b'),
      doneEntry('s-c', { role: 'coordinator' }),
      rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-1' }),
    ];
    const scan = (n: number) => (n >= 4 ? scanOf(holds('s-b', 'new:b'), holds('s-c', 'new:c', 6)) : scanOf());
    const { code, out, port, dir } = await run([appears('new:b', 4), appears('new:c', 4)], entries, scan);
    expect(code).toBe(0);
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-c', 's-b']);
    expect(sentTo(port)).toEqual(['term_new:c', 'term_new:b']);
    expect(port.sends[0]?.text).toBe(continueText(TOKEN, ['repo/tree-s-w (dispatch d-1)']));
    expect(resultsOf(out)).toEqual({ 's-c': 'acked', 's-b': 'acked', 's-w': 'left-to-coordinator' });
    expect(only(dir)).toMatchObject({ status: 'closed', endedBy: 'done' });
    expect(readPointer(dir)).toBeNull();
  });

  it('prompts an agent that Orca restored while the confirmation was open, found restored right before its start, and does not start it', async () => {
    const scan = (n: number) => (n === 1 ? scanOf() : scanOf(holds('s-a', 'new:a')));
    const { code, out, port } = await run([live('new:a')], [rosterEntry('s-a')], scan);
    expect(code).toBe(0);
    expect(port.starts).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
    expect(sentTo(port)).toEqual(['term_new:a']);
  });

  it('prompts an agent whose held session appears in Orca during the re-check', async () => {
    const scan = (n: number) => (n === 1 ? scanOf({ sessionId: 's-a', paneKey: null }) : scanOf(holds('s-a', 'new:a')));
    const { code, out, port } = await run([live('new:a')], [rosterEntry('s-a')], scan);
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
    expect(sentTo(port)).toEqual(['term_new:a']);
  });
});

describe('the send check and the ack proof', () => {
  it('does not send to an agent on a permission prompt: waiting-permission, exit 1, and nothing is sent', async () => {
    const { code, out, port } = await run([live('new:a', waiting)], [rosterEntry('s-a')], scanOf(holds('s-a', 'new:a')), ['--timeout', '6s']);
    expect(code).toBe(1);
    expect(port.sends).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/waiting-permission' });
  });

  it('sends once the agent leaves the permission prompt', async () => {
    const becomesReady: Behavior = ({ listCalls, received }) => (listCalls < 6 ? { state: 'waiting', message: OLD } : acks({ listCalls, received }));
    const { code, out, port } = await run([live('new:a', becomesReady)], [rosterEntry('s-a')], scanOf(holds('s-a', 'new:a')));
    expect(code).toBe(0);
    expect(port.sends).toHaveLength(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'acked' });
  });

  it('send-failed ends the wait at once, with exit 1', async () => {
    const { code, out, clock } = await recoverRun(['--yes', '--json'], [live('new:a')], [rosterEntry('s-a')], {
      scan: scanOf(holds('s-a', 'new:a')),
      newToken: () => TOKEN,
      configure: (p) => (p.sendResult = () => ({ accepted: false, reason: 'not-accepted' })),
    });
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/send-failed' });
    expect(clock.slept).toBe(0);
  });

  it('a reply without the ack line is no-ack and is not sent a second time', async () => {
    const { code, out, port } = await run([live('new:a', repliesWithoutAck)], [rosterEntry('s-a')], scanOf(holds('s-a', 'new:a')), ['--timeout', '6s']);
    expect(code).toBe(1);
    expect(port.sends).toHaveLength(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/no-ack' });
  });

  it('an agent that is still working at the timeout is still-working, and one in the background is background', async () => {
    const background: Behavior = () => ({ state: 'working', message: OLD, mainAgentState: 'done' });
    const { out } = await run([live('new:a', stillWorking), live('new:b', background)], [rosterEntry('s-a'), rosterEntry('s-b')], scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b', 6)), ['--timeout', '6s']);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/still-working', 's-b': 'pending/background' });
  });

  it('a reply that already ended with the ack line before the send is no proof', async () => {
    const stale: Behavior = () => ({ state: 'done', message: `Old.\nORCA-ACK ${TOKEN}` });
    const { out } = await run([live('new:a', stale)], [rosterEntry('s-a')], scanOf(holds('s-a', 'new:a')), ['--timeout', '6s']);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/still-working' });
  });

  it('keeps the record open with the pid cleared when a row stays pending', async () => {
    const { dir } = await run([live('new:a', repliesWithoutAck)], [rosterEntry('s-a')], scanOf(holds('s-a', 'new:a')), ['--timeout', '6s']);
    const record = only(dir);
    expect(record).toMatchObject({ status: 'open' });
    expect(record.pid).toBeUndefined();
    expect(record.rows[0]).toMatchObject({ status: 'pending', reason: 'no-ack', messagePending: false, baseline: OLD });
    expect(readPointer(dir)).toEqual({ kind: 'recovery', id: record.id });
  });
});

describe('gone rows and rows whose turn never came', () => {
  it.each([
    ['terminal-closed', 'missing'],
    ['terminal-orphaned', 'orphaned'],
    ['agent-exited', 'not-claude'],
  ] as const)('%s when the agent disappears before the prompt', async (reason, mode) => {
    const { code, out, port } = await run([live('new:a', acks, { terminalAt: (n) => (n >= 2 ? mode : 'ok') })], [rosterEntry('s-a')], scanOf(holds('s-a', 'new:a')));
    expect(code).toBe(1);
    expect(port.sends).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-a': `gone/${reason}` });
  });

  it('agent-missing when its row disappears', async () => {
    const { out } = await run([live('new:a', acks, { rowAt: (n) => n < 2 })], [rosterEntry('s-a')], scanOf(holds('s-a', 'new:a')));
    expect(resultsOf(out)).toEqual({ 's-a': 'gone/agent-missing' });
  });

  it('a restarted agent that disappears after its prompt is gone, on the pane where it was last seen', async () => {
    const scan = (n: number) => (n >= 3 ? scanOf(holds('s-a', 'new:a')) : scanOf());
    const { out } = await run([appears('new:a', 3, stillWorking)], [rosterEntry('s-a')], scan, ['--timeout', '20s']);
    expect(resultsOf(out)['s-a']).toBe('pending/still-working');
    const vanishes = live('new:a', stillWorking, { rowAt: (n) => n < 5, terminalAt: (n) => (n >= 5 ? 'missing' : n >= 3 ? 'ok' : 'missing') });
    const gone = await run([vanishes], [rosterEntry('s-a')], scan, ['--timeout', '20s']);
    expect(resultsOf(gone.out)['s-a']).toBe('gone/terminal-closed');
  });

  it('takes the pane of the newest process that holds the session when the agent leaves the live panes', async () => {
    const scan = scanOf(holds('s-a', 'dead:x', 1), holds('s-a', 'new:a', 9));
    const { out } = await run([live('new:a', stillWorking, { terminalAt: (n) => (n >= 3 ? 'orphaned' : 'ok') })], [rosterEntry('s-a')], scan, ['--timeout', '20s']);
    expect(resultsOf(out)).toEqual({ 's-a': 'gone/terminal-orphaned' });
  });

  it('a start skipped because the deadline passed leaves a due prompt row pending timed-out, not gone', async () => {
    const clock = fakeClock(T0);
    const entries = [rosterEntry('s-a'), rosterEntry('s-b')];
    const { out, port } = await recoverRun(['--yes', '--json', '--timeout', '2s'], [], entries, {
      clock,
      newToken: () => TOKEN,
      configure: (p) => (p.startResultAt = (n) => ((clock.slept += 3000), { started: true, handle: `term_${n}` })),
    });
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/did-not-appear', 's-b': 'pending/timed-out' });
  });
});

describe('worker rows', () => {
  const coordinator = doneEntry('s-c', { role: 'coordinator' });
  const worker = rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-1' });

  it('stays left-to-coordinator when the list was sent, even if the coordinator then ends no-ack', async () => {
    const { code, out } = await run([live('new:c', repliesWithoutAck)], [coordinator, worker], scanOf(holds('s-c', 'new:c')), ['--timeout', '6s']);
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-c': 'pending/no-ack', 's-w': 'left-to-coordinator' });
  });

  it('is no-coordinator, coordinator-missing and final when its coordinator did not appear, and the record closes', async () => {
    const { code, out, dir } = await run([], [coordinator, worker], scanOf(), ['--timeout', '4s']);
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-c': 'failed/did-not-appear', 's-w': 'no-coordinator/coordinator-missing' });
    expect(only(dir)).toMatchObject({ status: 'closed', endedBy: 'done' });
  });

  it('is no-coordinator but not final while its coordinator row is still pending, so the record stays open', async () => {
    const { code, out, dir, port } = await run([live('new:c', waiting)], [coordinator, worker], scanOf(holds('s-c', 'new:c')), ['--timeout', '4s']);
    expect(code).toBe(1);
    expect(port.sends).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-c': 'pending/waiting-permission', 's-w': 'no-coordinator/coordinator-missing' });
    expect(only(dir)).toMatchObject({ status: 'open' });
  });

  it('is no-coordinator when its coordinator is gone before the list is sent', async () => {
    const { out, dir } = await run([live('new:c', acks, { terminalAt: (n) => (n >= 2 ? 'missing' : 'ok') })], [coordinator, worker], scanOf(holds('s-c', 'new:c')));
    expect(resultsOf(out)).toEqual({ 's-c': 'gone/terminal-closed', 's-w': 'no-coordinator/coordinator-missing' });
    expect(only(dir)).toMatchObject({ status: 'closed' });
  });

  it('keeps coordinator-is-self for the workers of the session that runs recover: they count toward the exit code and appear on the self line', async () => {
    const selfCoordinator = rosterEntry('s-c', { role: 'coordinator' });
    const other = rosterEntry('s-a');
    const { code, out, port } = await recoverRun(['--yes'], [live('new:c'), live('new:a')], [selfCoordinator, worker, other], {
      scan: scanOf(holds('s-c', 'new:c'), holds('s-a', 'new:a', 6)),
      env: { ORCA_PANE_KEY: 'new:c' },
      newToken: () => TOKEN,
    });
    expect(code).toBe(1);
    expect(sentTo(port)).toEqual(['term_new:a']);
    expect(out).toContain('missing workers: repo/tree-s-w (dispatch d-1)');
    expect(out).toMatch(/tree-s-w\s+worker\s+no-coordinator\s+coordinator-is-self/);
    expect((out.split('self (')[0] as string)).not.toMatch(/tree-s-c\s/);
  });
});

describe('interruption', () => {
  it('a signal while the prompt loop waits saves the record with the pid cleared and exits 130', async () => {
    const signals = new EventEmitter();
    const { code, out, dir } = await recoverRun(['--yes', '--json'], [live('new:a', repliesWithoutAck)], [rosterEntry('s-a')], {
      scan: scanOf(holds('s-a', 'new:a')),
      newToken: () => TOKEN,
      signals,
      onSleep: () => signals.emit('SIGTERM'),
    });
    expect(code).toBe(130);
    expect(parseJson(out).error).toBe('interrupted by SIGTERM');
    const record = only(dir);
    expect(record.pid).toBeUndefined();
    expect(record).toMatchObject({ status: 'open' });
    expect(record.rows[0]).toMatchObject({ status: 'pending', messagePending: false });
  });
});
