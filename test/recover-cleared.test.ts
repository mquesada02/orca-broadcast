import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recover } from '../src/recover.js';
import { createRecordStore } from '../src/store.js';
import type { RecoverPlan, RecoveryRecord, RecoveryRow, RosterEntry } from '../src/types.js';
import { agentRecord, fakeClock, FakeOrca, seedOpenRun, tempStateDir } from './helpers/fake-orca.js';
import { doneEntry, GONE, parseJson, recoverRun } from './helpers/recover.js';
import { rosterEntry, rosterSnapshot, scanOf, seedRosters, T0 } from './helpers/roster.js';
import { runCli, type Seed } from './helpers/run-cli.js';

const LIVE = { bootId: 'boot-1', runtimeId: 'runtime-1' };
const A = { repo: 'repo', worktree: 'tree-s-a' };
const CLEAR_LINE = 'Each worktree below is cleared (its restored tabs are closed) only if it still has no live terminal when its first agent starts:';

// A second agent in the worktree of `s-a`.
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

// A seed that stores an open recovery record with these rows (and, when given, an earlier cleared list).
const seedRecord =
  (rows: RecoveryRow[], cleared?: RecoveryRecord['cleared']): Seed =>
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
      ...(cleared ? { cleared } : {}),
    };
    await store.saveRecovery(record);
    await store.setCurrent('recovery', record.id);
  };

const pauseRunSeed: Seed = async (store) => {
  await seedRosters(rosterSnapshot(GONE, [rosterEntry('s-a')]))(store);
  await seedOpenRun(store, [agentRecord('old:s-a', { role: 'session', sessionId: 's-a' })]);
};

// `recover` called directly with a confirm that keeps the plan it was shown.
async function planOf(entries: RosterEntry[], opts: { keepTabs?: boolean; configure?: (port: FakeOrca) => void } = {}): Promise<RecoverPlan> {
  const dir = await tempStateDir();
  const store = createRecordStore(join(dir, 'orca-broadcast'));
  await seedRosters(rosterSnapshot(GONE, entries))(store);
  const port = new FakeOrca([]);
  port.scanAt = () => scanOf();
  opts.configure?.(port);
  let shown: RecoverPlan | undefined;
  await recover(600_000, {
    port,
    clock: fakeClock(T0),
    store,
    confirm: async (plan) => ((shown = plan), false),
    keepTabs: opts.keepTabs,
  });
  return shown as RecoverPlan;
}

describe('recover: the plan lists the worktrees to clear', () => {
  it('lists each worktree once, also with two restarts in it', async () => {
    const plan = await planOf([doneEntry('s-a'), sameTree('s-b'), doneEntry('s-c')]);
    expect(plan.clears).toEqual([A, { repo: 'repo', worktree: 'tree-s-c' }]);
  });

  it('lists no worktree that has a live or an orphaned terminal row', async () => {
    const plan = await planOf([doneEntry('s-a'), doneEntry('s-b'), doneEntry('s-c')], {
      configure: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/tree-s-a' }, { paneKey: 'shell:2', worktreePath: '/work/tree-s-b', orphaned: true }),
    });
    expect(plan.clears).toEqual([{ repo: 'repo', worktree: 'tree-s-c' }]);
  });

  it('lists no worktree that has restored terminals but no restart', async () => {
    const plan = await planOf([doneEntry('s-a')], { configure: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/elsewhere' }) });
    expect(plan.clears).toEqual([A]);
  });

  it('is empty with --keep-tabs', async () => {
    expect((await planOf([doneEntry('s-a')], { keepTabs: true })).clears).toEqual([]);
  });
});

describe('recover: the prompt', () => {
  it('prints the line and one clear line per worktree', async () => {
    const { err } = await recoverRun([], [], [doneEntry('s-a'), sameTree('s-b')], { ask: ['y'] });
    expect(err).toContain(`  ${CLEAR_LINE}\n  clear repo/tree-s-a\n`);
    expect(err.match(/clear repo\//g)).toHaveLength(1);
    // The clear lines come after the restart lines and before the question.
    expect(err.indexOf('restart repo/tree-s-a')).toBeLessThan(err.indexOf(CLEAR_LINE));
  });

  it('prints neither the line nor an item with --keep-tabs, or when no worktree is to be cleared', async () => {
    const kept = await recoverRun(['--keep-tabs'], [], [doneEntry('s-a')], { ask: ['y'] });
    expect(kept.err).toContain('restart repo/tree-s-a');
    expect(kept.err).not.toContain(CLEAR_LINE);
    expect(kept.err).not.toContain('  clear ');
    const occupied = await recoverRun([], [], [doneEntry('s-a')], { ask: ['y'], configure: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/tree-s-a' }) });
    expect(occupied.err).not.toContain(CLEAR_LINE);
  });

  it('a re-run lists the worktrees from the listing it holds', async () => {
    const { err } = await recoverRun([], [], [], { ask: ['y'], seed: seedRecord([recordRow('s-a', {})]) });
    expect(err).toContain(`  ${CLEAR_LINE}\n  clear repo/tree-s-a\n`);
    const kept = await recoverRun(['--keep-tabs'], [], [], { ask: ['y'], seed: seedRecord([recordRow('s-a', {})]) });
    expect(kept.err).not.toContain(CLEAR_LINE);
  });
});

describe('recover: the report and the JSON line', () => {
  it('prints one cleared line per cleared worktree', async () => {
    const { out } = await recoverRun(['--yes'], [], [doneEntry('s-a'), sameTree('s-b'), doneEntry('s-c')]);
    expect(out.match(/^cleared .*$/gm)).toEqual(['cleared repo/tree-s-a', 'cleared repo/tree-s-c']);
  });

  it('prints no cleared line with --keep-tabs, with a live terminal, or after a failed clear', async () => {
    const kept = await recoverRun(['--yes', '--keep-tabs'], [], [doneEntry('s-a')]);
    expect(kept.out).not.toMatch(/^cleared /m);
    const live = await recoverRun(['--yes'], [], [doneEntry('s-a')], { configure: (p) => p.plainTerminals.push({ paneKey: 'shell:1', worktreePath: '/work/tree-s-a' }) });
    expect(live.out).not.toMatch(/^cleared /m);
    const failed = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { configure: (p) => (p.clearResultAt = () => ({ cleared: false, message: 'close failed: boom' })) });
    expect(parseJson(failed.out).cleared).toEqual([]);
    expect(parseJson(failed.out).warnings).toContain('close failed: boom');
    const failedText = await recoverRun(['--yes'], [], [doneEntry('s-a')], { configure: (p) => (p.clearResultAt = () => ({ cleared: false, message: 'close failed: boom' })) });
    expect(failedText.out).not.toMatch(/^cleared /m);
  });

  it('puts the cleared list in the JSON line and in the record', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a'), doneEntry('s-c')]);
    const json = parseJson(out);
    const expected = [A, { repo: 'repo', worktree: 'tree-s-c' }];
    expect(json.cleared).toEqual(expected);
    expect(json.record?.cleared).toEqual(expected);
  });

  it('has an empty list when nothing was cleared, when the user declines, and in an error line', async () => {
    const kept = await recoverRun(['--yes', '--json', '--keep-tabs'], [], [doneEntry('s-a')]);
    expect(parseJson(kept.out).cleared).toEqual([]);
    const declined = await recoverRun([], [], [doneEntry('s-a')], { ask: ['n'] });
    expect(declined.port.clears).toEqual([]);
    expect(declined.out).not.toMatch(/^cleared /m);
    const nothing = await recoverRun(['--yes', '--json'], [], []);
    expect(parseJson(nothing.out).cleared).toEqual([]);
    // No roster at all: the run ends in an error line.
    const error = await runCli(['recover', '--json', '--yes'], []);
    expect(parseJson(error.out).outcome).toBe('error');
    expect(parseJson(error.out).cleared).toEqual([]);
  });

  it('a re-run appends to the record and reports only its own clear', async () => {
    const earlier = [{ repo: 'repo', worktree: 'tree-old' }];
    const { out } = await recoverRun(['--yes', '--json'], [], [], { seed: seedRecord([recordRow('s-a', {})], earlier) });
    const json = parseJson(out);
    expect(json.cleared).toEqual([A]);
    expect(json.record?.cleared).toEqual([...earlier, A]);
  });

  it('a record of an older run without the field is re-run and gets the field', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [], { seed: seedRecord([recordRow('s-a', {})]) });
    expect(parseJson(out).record?.cleared).toEqual([A]);
  });

  it('the record keeps a clear when the run fails later', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], {
      configure: (p) => {
        p.failListingsFrom = 4;
      },
    });
    const json = parseJson(out);
    expect(json.outcome).toBe('error');
    expect(json.record?.cleared).toEqual([A]);
  });

  it('in pause-run mode the summary holds the list and no record is written', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [], { seed: pauseRunSeed });
    const json = parseJson(out);
    expect(json.cleared).toEqual([A]);
    expect(json.record).toBeNull();
  });
});
