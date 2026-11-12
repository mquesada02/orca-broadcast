import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { TerminalSize } from '../src/block.js';
import type { AgentRecord, RecoveryRecord, RecoveryRow, RosterEntry, Run } from '../src/types.js';
import { agentRecord, fakeClock, seedOpenRun, type Behavior, type FakeAgent } from './helpers/fake-orca.js';
import { doneEntry, GONE, recoverRun, type RecoverOptions } from './helpers/recover.js';
import { agent, rosterEntry, rosterSnapshot, scanOf, seedRosters } from './helpers/roster.js';
import type { Seed } from './helpers/run-cli.js';

const CLEAR = '\r\x1b[J';
const TOKEN = 'tok1';
const OLD = 'Earlier reply.';
const LIVE = { bootId: 'boot-1', runtimeId: 'runtime-1' };
const roomy: TerminalSize = { rows: 30, columns: 100 };

/** The blocks that were drawn: every chunk of stderr that starts a redraw. */
const chunks = (err: string): string[] => err.split(/(?=\r(?:\x1b\[\d+A)?\x1b\[J)/).filter((c) => c !== '');

// An agent that never acks, one that acks once it was sent the prompt, and one whose ack comes after `polls` more listings.
const silent: Behavior = () => ({ state: 'working', message: OLD });
const acksAfterSend: Behavior = ({ received }) => ({ state: 'done', message: received.length > 0 ? `Handled it.\nORCA-ACK ${TOKEN}` : OLD });
const acksAfter = (polls: number): Behavior => {
  let seen = 0;
  return ({ received }) => {
    if (received.length === 0) return { state: 'working', message: OLD };
    seen += 1;
    return seen > polls ? { state: 'done', message: `Handled it.\nORCA-ACK ${TOKEN}` } : { state: 'working', message: OLD };
  };
};

const live = (paneKey: string, behavior: Behavior): FakeAgent => agent(paneKey, { behavior });
// An agent whose row and terminal exist from this listing number on.
const appears = (paneKey: string, from: number, behavior: Behavior = acksAfterSend): FakeAgent => agent(paneKey, { behavior, rowAt: (n) => n >= from, terminalAt: (n) => (n >= from ? 'ok' : 'missing') });
const holds = (sessionId: string, paneKey: string) => ({ sessionId, paneKey, startTime: 5 });

const recover = (agents: FakeAgent[], entries: RosterEntry[], opts: RecoverOptions = {}, argv: string[] = []) => recoverRun(['--yes', '--timeout', '10s', ...argv], agents, entries, { newToken: () => TOKEN, isTTY: true, size: roomy, ...opts });

describe('recover on a terminal: the block, crash mode', () => {
  it('draws the count line and one aligned row per row that is not final, with the reason, sorted', async () => {
    const entries = [rosterEntry('s-b'), rosterEntry('s-a'), rosterEntry('s-c', { repo: 'aardvark' })];
    const agents = [live('new:a', silent), live('new:b', silent), live('new:c', silent)];
    const scan = scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b'), holds('s-c', 'new:c'));
    const { err } = await recover(agents, entries, { scan });
    expect(chunks(err)[0]).toMatch(/^\r\x1b\[Jrecovering… 0\/3 final\n {2}aardvark\/tree-s-c {2}session {2}\S+\n {2}repo\/tree-s-a {6}session {2}\S+\n {2}repo\/tree-s-b {6}session {2}\S+$/);
  });

  it('drops a row from the next block when it becomes final, and the count line follows', async () => {
    const entries = [rosterEntry('s-a'), rosterEntry('s-b')];
    const agents = [live('new:a', acksAfterSend), live('new:b', silent)];
    const { err } = await recover(agents, entries, { scan: scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b')) });
    const blocks = chunks(err);
    expect(blocks[0]).toContain('recovering… 0/2 final');
    expect(blocks[0]).toContain('repo/tree-s-a');
    const second = blocks.find((b) => b.includes('1/2 final')) as string;
    expect(second).toMatch(/^\r\x1b\[2A\x1b\[Jrecovering… 1\/2 final\n {2}repo\/tree-s-b {2}session {2}\S+$/);
  });

  it('shows a restarted row whose prompt is not acked yet as pending, and drops it when the prompt is acked', async () => {
    const { err } = await recover([appears('new:a', 4, acksAfter(2))], [rosterEntry('s-a')], { scan: (n) => (n >= 4 ? scanOf(holds('s-a', 'new:a')) : scanOf()) });
    const blocks = chunks(err);
    expect(blocks[0]).toMatch(/^\r\x1b\[Jrecovering… 0\/1 final\n {2}repo\/tree-s-a {2}session {2}awaiting-start$/);
    expect(blocks.some((b) => b.includes('0/1 final') && /tree-s-a {2}session {2}\S+/.test(b) && !b.includes('awaiting-start'))).toBe(true);
    expect(blocks.at(-2)).toContain('1/1 final');
  });

  it('clears the block before the report, with the report after it', async () => {
    const { err, out } = await recover([live('new:a', acksAfterSend)], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a')) });
    expect(err).toMatch(/1\/1 final\r\x1b\[J$/);
    expect(out).toContain('acked');
  });

  it('clears the block before the report after an abort', async () => {
    const signals = new EventEmitter();
    let sleeps = 0;
    const clock = fakeClock();
    clock.onSleep = () => {
      sleeps += 1;
      if (sleeps === 2) signals.emit('SIGINT');
    };
    const { err } = await recover([live('new:a', silent)], [rosterEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a')), signals, clock });
    expect(err).toContain('recovering… 0/1 final');
    expect(chunks(err).at(-1)).toMatch(/^\r\x1b\[1A\x1b\[J(?:orca-broadcast: .*\n)?$/);
  });

  it('shows `… and N more` when the pending rows do not fit the terminal', async () => {
    const entries = [rosterEntry('s-a'), rosterEntry('s-b'), rosterEntry('s-c'), rosterEntry('s-d')];
    const agents = ['a', 'b', 'c', 'd'].map((x) => live(`new:${x}`, silent));
    const scan = scanOf(...['a', 'b', 'c', 'd'].map((x) => holds(`s-${x}`, `new:${x}`)));
    const { err } = await recover(agents, entries, { scan, size: { rows: 5, columns: 100 } });
    expect(chunks(err)[0]).toMatch(/^\r\x1b\[Jrecovering… 0\/4 final\n {2}repo\/tree-s-a .*\n {2}repo\/tree-s-b .*\n {2}… and 2 more$/);
  });

  it('draws no block without a TTY, and none with --json on a TTY', async () => {
    const entries = [rosterEntry('s-a')];
    const agents = [live('new:a', silent)];
    const scan = scanOf(holds('s-a', 'new:a'));
    const plain = await recover(agents, entries, { scan, isTTY: false });
    expect(plain.err).not.toContain('recovering');
    const json = await recover([live('new:a', silent)], entries, { scan }, ['--json']);
    expect(json.err).not.toContain('recovering');
    expect(json.err).not.toContain('\x1b[');
  });

  it('draws no block when there is nothing to start, send or wait on', async () => {
    const { err } = await recover([], [doneEntry('s-a')], { scan: scanOf(holds('s-a', 'new:a')) });
    expect(err).not.toContain('recovering');
  });
});

describe('recover on a terminal: the confirm prompt', () => {
  it('clears with the block clear before the prompt text, and writes no line clear', async () => {
    const { err, questions } = await recoverRun(['--timeout', '10s'], [live('new:a', acksAfterSend)], [rosterEntry('s-a')], { newToken: () => TOKEN, isTTY: true, size: roomy, scan: scanOf(holds('s-a', 'new:a')), ask: ['y'] });
    expect(questions[0]).toContain('Restart');
    expect(err.startsWith(CLEAR)).toBe(true);
    expect(err.indexOf('prompt repo/tree-s-a')).toBeGreaterThan(err.indexOf(CLEAR));
    expect(err).not.toContain('\r\x1b[K');
    expect(err.slice(0, err.indexOf('prompt repo/tree-s-a'))).not.toContain('recovering');
  });
});

// A stored row whose prompt has not been sent.
const row = (id: string, extra: Partial<RecoveryRow> = {}): RecoveryRow => ({ ...rosterEntry(id), status: 'pending', reason: 'timed-out', promptDue: true, messagePending: true, baseline: null, ...extra });
const record = (rows: RecoveryRow[]): RecoveryRecord => ({
  id: 'r1',
  token: TOKEN,
  createdAt: '2026-02-28T23:00:00.000Z',
  status: 'open',
  snapshotKey: GONE,
  liveRuntime: LIVE,
  snapshots: [{ lastSave: '2026-02-28T23:55:00.000Z', ageMinutes: 5 }],
  rows,
});
const seedRecord =
  (rec: RecoveryRecord): Seed =>
  async (store) => {
    await store.saveRecovery(rec);
    await store.setCurrent('recovery', rec.id);
  };

describe('recover on a terminal: the block, re-run', () => {
  it('counts and shows only the rows of the filtered scope', async () => {
    const rec = record([row('s-a'), row('s-b', { repo: 'other', repoId: 'repo-other' })]);
    const { err } = await recoverRun(['--yes', '--timeout', '10s', '--repo', 'repo'], [live('new:a', silent), live('new:b', silent)], [], {
      isTTY: true,
      size: roomy,
      seed: seedRecord(rec),
      scan: scanOf(holds('s-a', 'new:a'), holds('s-b', 'new:b')),
      configure: (port) => {
        port.repos = [
          { id: 'repo-repo', path: '/r/repo', displayName: 'repo' },
          { id: 'repo-other', path: '/r/other', displayName: 'other' },
        ];
      },
    });
    const first = chunks(err)[0] as string;
    expect(first).toContain('recovering… 0/1 final');
    expect(first).toContain('repo/tree-s-a');
    expect(first).not.toContain('other/');
  });
});

// A roster of the runtime that is gone, and an open pause run, in the state folder.
const seedRun =
  (entries: RosterEntry[], agents: AgentRecord[]): Seed =>
  async (store) => {
    await seedRosters(rosterSnapshot(GONE, entries))(store);
    await seedOpenRun(store, agents, {} as Partial<Run>);
  };
const runAgent = (sessionId: string): AgentRecord => agentRecord(`old:${sessionId}`, { role: 'session', sessionId });

describe('recover on a terminal: the block, pause-run mode', () => {
  it('shows the rows that wait for their restart with reason awaiting-start, and drops them when they are final', async () => {
    const { err } = await recoverRun(['--yes', '--timeout', '10s'], [appears('new:a', 6), appears('new:b', 9)], [], {
      isTTY: true,
      size: roomy,
      seed: seedRun([rosterEntry('s-a'), rosterEntry('s-b')], [runAgent('s-a'), runAgent('s-b')]),
      scan: (n) => scanOf(...(n >= 6 ? [holds('s-a', 'new:a')] : []), ...(n >= 9 ? [holds('s-b', 'new:b')] : [])),
    });
    const blocks = chunks(err);
    expect(blocks[0]).toMatch(/^\r\x1b\[Jrecovering… 0\/2 final\n {2}repo\/tree-s-a {2}session {2}awaiting-start\n {2}repo\/tree-s-b {2}session {2}awaiting-start$/);
    expect(blocks.some((b) => b.includes('1/2 final') && b.includes('tree-s-b') && !b.includes('tree-s-a'))).toBe(true);
  });
});
