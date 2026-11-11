import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recover } from '../src/recover.js';
import { createRecordStore } from '../src/store.js';
import type { RecoveryRecord, RecoveryRow, RosterEntry, SessionScan } from '../src/types.js';
import { fakeClock, FakeOrca, seedOpenRun, tempStateDir, agentRecord, type FakeAgent } from './helpers/fake-orca.js';
import { doneEntry, GONE, parseJson, recoverRun } from './helpers/recover.js';
import { agent, rosterEntry, rosterSnapshot, scanOf, seedRosters, T0 } from './helpers/roster.js';
import type { Seed } from './helpers/run-cli.js';

const LIVE = { bootId: 'boot-1', runtimeId: 'runtime-1' };

// The entry of a second agent in the worktree of `s-a`.
const sameTree = (sessionId: string): RosterEntry => doneEntry(sessionId, { worktree: 'tree-s-a', worktreeId: 'wt-s-a', worktreePath: '/work/tree-s-a' });

// A row of an open recovery record, in the worktree of `s-a`.
const recordRow = (sessionId: string, extra: Partial<RecoveryRow>): RecoveryRow => ({
  ...sameTree(sessionId),
  status: 'pending',
  reason: 'timed-out',
  promptDue: false,
  messagePending: false,
  baseline: null,
  ...extra,
});

// A seed that stores an open recovery record with these rows.
const seedRecord =
  (rows: RecoveryRow[]): Seed =>
  async (store) => {
    const record: RecoveryRecord = {
      id: 'r1',
      token: '***',
      createdAt: '2026-02-28T23:00:00.000Z',
      status: 'open',
      snapshotKey: GONE,
      liveRuntime: LIVE,
      snapshots: [{ lastSave: '2026-02-28T23:55:00.000Z', ageMinutes: 5 }],
      rows,
    };
    await store.saveRecovery(record);
    await store.setCurrent('recovery', record.id);
  };

// What the fake Orca got, in order: `clear:<path>` and `start:<session>`.
const calls = (port: FakeOrca): string[] => port.events;

// `recover` called directly, so a test can read the summary (the CLI prints no `cleared` yet).
async function recoverDirect(opts: { agents?: FakeAgent[]; entries: RosterEntry[]; keepTabs?: boolean; scan?: SessionScan; configure?: (port: FakeOrca) => void; confirm?: () => boolean; lateTerminal?: (port: FakeOrca) => void }) {
  const dir = await tempStateDir();
  const store = createRecordStore(join(dir, 'orca-broadcast'));
  await seedRosters(rosterSnapshot(GONE, opts.entries))(store);
  const port = new FakeOrca(opts.agents ?? []);
  port.scanAt = () => opts.scan ?? scanOf();
  opts.configure?.(port);
  const confirm = opts.confirm || opts.lateTerminal ? async () => (opts.lateTerminal?.(port), opts.confirm?.() ?? true) : undefined;
  const summary = await recover(600_000, { port, clock: fakeClock(T0), store, confirm, keepTabs: opts.keepTabs });
  return { summary, port };
}

describe('recover: clearing the restored tabs of a worktree', () => {
  it('clears an empty worktree before the first start there', async () => {
    const { port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')]);
    expect(calls(port)).toEqual(['clear:/work/tree-s-a', 'start:s-a']);
  });

  it('does not clear a worktree with a live terminal', async () => {
    const { port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { configure: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/tree-s-a' }) });
    expect(calls(port)).toEqual(['start:s-a']);
  });

  it('does not clear a worktree with an orphaned terminal', async () => {
    const { port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { configure: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/tree-s-a', orphaned: true }) });
    expect(calls(port)).toEqual(['start:s-a']);
  });

  it('a terminal in another worktree does not stop the clear, and that other worktree is never cleared', async () => {
    const { port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { configure: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/other' }) });
    expect(port.clears).toEqual(['/work/tree-s-a']);
  });

  it.each([false, true])('clears once for two agents in one worktree (the first start opens a terminal: %s)', async (opens) => {
    const { port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a'), sameTree('s-b')], { configure: (p) => (p.startOpensTerminal = opens) });
    expect(port.clears).toEqual(['/work/tree-s-a']);
    expect(calls(port).filter((c) => c.startsWith('start:'))).toHaveLength(2);
    expect(calls(port)[0]).toBe('clear:/work/tree-s-a');
  });

  it('a terminal that appears between the prompt and the start prevents the clear', async () => {
    const { summary, port } = await recoverDirect({ entries: [doneEntry('s-a')], lateTerminal: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/tree-s-a' }) });
    expect(port.clears).toEqual([]);
    expect(port.starts).toHaveLength(1);
    expect(summary.recovery?.cleared).toEqual([]);
  });

  it('a worktree whose agent is live and needs no restart gets no clear, and the restart elsewhere does', async () => {
    const live = agent('new:b', { worktree: 'tree-s-b' });
    const { port } = await recoverRun(['--yes', '--json'], [live], [doneEntry('s-a'), doneEntry('s-b')], { scan: scanOf({ sessionId: 's-b', paneKey: 'new:b', startTime: 5 }) });
    expect(port.clears).toEqual(['/work/tree-s-a']);
  });

  it('--keep-tabs clears nothing and still starts', async () => {
    const { port } = await recoverRun(['--yes', '--json', '--keep-tabs'], [], [doneEntry('s-a')]);
    expect(calls(port)).toEqual(['start:s-a']);
  });

  it('a failed clear warns, the start still happens, and a second agent in that worktree does not clear again', async () => {
    const { out, port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a'), sameTree('s-b')], { configure: (p) => (p.clearResultAt = () => ({ cleared: false, message: 'close failed: boom' })) });
    expect(port.clears).toHaveLength(1);
    expect(port.starts).toHaveLength(2);
    expect(parseJson(out).warnings).toContain('close failed: boom');
  });

  it('a re-run does not clear a worktree where the first run started an agent', async () => {
    // The open record of the first run: s-a started and appeared (its new tab is the terminal below), s-b is still due a start.
    const seed = seedRecord([recordRow('s-a', { status: 'restarted', reason: null }), recordRow('s-b', {})]);
    const { port } = await recoverRun(['--yes', '--json'], [], [], { seed, configure: (p) => p.plainTerminals.push({ paneKey: 'started:1', worktreePath: '/work/tree-s-a' }) });
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-b']);
    expect(port.clears).toEqual([]);
  });

  it('a row started again in the wait step does not clear a worktree that was already considered', async () => {
    // s-b was started by an earlier run an hour ago and never appeared; s-a is due a start now.
    const seed = seedRecord([recordRow('s-a', {}), recordRow('s-b', { reason: 'awaiting-start', startedAt: new Date(T0 - 3_600_000).toISOString() })]);
    const { port } = await recoverRun(['--yes', '--json'], [], [], { seed });
    expect(port.starts.map((s) => s.sessionId).sort()).toEqual(['s-a', 's-b']);
    expect(port.clears).toEqual(['/work/tree-s-a']);
  });
});

describe('recover with an open pause run: clearing', () => {
  it('clears the same way before it restarts a run agent', async () => {
    const seed: Seed = async (store) => {
      await seedRosters(rosterSnapshot(GONE, [rosterEntry('s-a')]))(store);
      await seedOpenRun(store, [agentRecord('old:s-a', { role: 'session', sessionId: 's-a' })]);
    };
    const { port } = await recoverRun(['--yes', '--json'], [], [], { seed });
    expect(calls(port)).toEqual(['clear:/work/tree-s-a', 'start:s-a']);
  });

  it('does not clear a worktree with a live terminal', async () => {
    const seed: Seed = async (store) => {
      await seedRosters(rosterSnapshot(GONE, [rosterEntry('s-a')]))(store);
      await seedOpenRun(store, [agentRecord('old:s-a', { role: 'session', sessionId: 's-a' })]);
    };
    const { port } = await recoverRun(['--yes', '--json'], [], [], { seed, configure: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/tree-s-a' }) });
    expect(port.clears).toEqual([]);
  });
});

describe('recover: the cleared list of the summary', () => {
  it('names each cleared worktree once, in clear order', async () => {
    const { summary } = await recoverDirect({ entries: [doneEntry('s-a'), sameTree('s-b'), doneEntry('s-c')] });
    expect(summary.recovery?.cleared).toEqual([
      { repo: 'repo', worktree: 'tree-s-a' },
      { repo: 'repo', worktree: 'tree-s-c' },
    ]);
  });

  it('names no worktree with a live or an orphaned terminal', async () => {
    const { summary } = await recoverDirect({
      entries: [doneEntry('s-a'), doneEntry('s-b'), doneEntry('s-c')],
      configure: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/tree-s-a' }, { paneKey: 'shell:2', worktreePath: '/work/tree-s-b', orphaned: true }),
    });
    expect(summary.recovery?.cleared).toEqual([{ repo: 'repo', worktree: 'tree-s-c' }]);
  });

  it('is empty with --keep-tabs', async () => {
    const { summary } = await recoverDirect({ entries: [doneEntry('s-a')], keepTabs: true });
    expect(summary.recovery?.cleared).toEqual([]);
  });

  it('is empty when the user declines, and when there is nothing to recover', async () => {
    const declined = await recoverDirect({ entries: [doneEntry('s-a')], confirm: () => false });
    expect(declined.summary.recovery?.cleared).toEqual([]);
    const nothing = await recoverDirect({ entries: [] });
    expect(nothing.summary.recovery?.cleared).toEqual([]);
  });

  it('does not list a failed clear', async () => {
    const { summary } = await recoverDirect({ entries: [doneEntry('s-a')], configure: (p) => (p.clearResultAt = () => ({ cleared: false, message: 'boom' })) });
    expect(summary.recovery?.cleared).toEqual([]);
    expect(summary.warnings).toContain('boom');
  });

  it('keeps a clear after the run failed later', async () => {
    const { summary } = await recoverDirect({
      entries: [doneEntry('s-a')],
      configure: (p) => {
        // The listing after the start fails for good, so the run ends in an error after the clear.
        p.failListingsFrom = 4;
      },
    });
    expect(summary.outcome).toBe('error');
    expect(summary.recovery?.cleared).toEqual([{ repo: 'repo', worktree: 'tree-s-a' }]);
  });
});
