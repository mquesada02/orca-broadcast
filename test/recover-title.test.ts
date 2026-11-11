import { describe, expect, it } from 'vitest';
import type { AgentRecord, RecoveryRecord, RecoveryRow, Run, RosterEntry } from '../src/types.js';
import { agentRecord, seedOpenRun } from './helpers/fake-orca.js';
import { doneEntry, GONE, recoverRun } from './helpers/recover.js';
import { agent, rosterEntry, rosterSnapshot, seedRosters } from './helpers/roster.js';
import { readRecoveries } from './helpers/records.js';
import type { Seed } from './helpers/run-cli.js';

const TITLE = 'My tab';
const LIVE = { bootId: 'boot-1', runtimeId: 'runtime-1' };

// What each start received: the tab title and the title choice.
const choices = (port: { starts: { sessionId: string; title: string; disableTitleUpdates: boolean }[] }) => port.starts.map(({ sessionId, title, disableTitleUpdates }) => ({ sessionId, title, disableTitleUpdates }));

describe('recover: the tab title of a restarted agent', () => {
  it('a saved title is the tab title and Claude Code title updates are off', async () => {
    const { code, port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a', { title: TITLE })]);
    expect(code).toBe(1);
    expect(choices(port)).toEqual([{ sessionId: 's-a', title: TITLE, disableTitleUpdates: true }]);
  });

  it('no saved title gives the label with title updates on, also for an older roster whose entries have no title key', async () => {
    const entry = doneEntry('s-a');
    expect('title' in entry).toBe(false);
    const { port } = await recoverRun(['--yes', '--json'], [], [entry]);
    expect(choices(port)).toEqual([{ sessionId: 's-a', title: 'repo/tree-s-a (recovered)', disableTitleUpdates: false }]);
  });

  it('an empty title gives the label with title updates on', async () => {
    const { port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a', { title: '' })]);
    expect(choices(port)).toEqual([{ sessionId: 's-a', title: 'repo/tree-s-a (recovered)', disableTitleUpdates: false }]);
  });

  it('each of two agents gets its own choice', async () => {
    const { port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a', { title: TITLE }), doneEntry('s-b')]);
    expect(choices(port).sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: 's-a', title: TITLE, disableTitleUpdates: true },
      { sessionId: 's-b', title: 'repo/tree-s-b (recovered)', disableTitleUpdates: false },
    ]);
  });

  it('a re-run restarts a stored record row with the title that the row holds', async () => {
    const row: RecoveryRow = { ...rosterEntry('s-a', { title: TITLE }), status: 'pending', reason: 'timed-out', promptDue: false, messagePending: false, baseline: null };
    const rec: RecoveryRecord = {
      id: 'r1',
      token: 'tok1',
      createdAt: '2026-02-28T23:00:00.000Z',
      status: 'open',
      snapshotKey: GONE,
      liveRuntime: LIVE,
      snapshots: [{ lastSave: '2026-02-28T23:55:00.000Z', ageMinutes: 5 }],
      rows: [row],
    };
    const seed: Seed = async (store) => {
      await store.saveRecovery(rec);
      await store.setCurrent('recovery', rec.id);
    };
    const { port, dir } = await recoverRun(['--yes', '--json'], [], [], { seed });
    expect(choices(port)).toEqual([{ sessionId: 's-a', title: TITLE, disableTitleUpdates: true }]);
    expect(readRecoveries(dir)).toHaveLength(1);
  });
});

describe('recover with an open pause run: the tab title', () => {
  const seedRun =
    (entries: RosterEntry[], agents: AgentRecord[]): Seed =>
    async (store) => {
      await seedRosters(rosterSnapshot(GONE, entries))(store);
      await seedOpenRun(store, agents, {} as Partial<Run>);
    };
  const runAgent = (sessionId: string): AgentRecord => agentRecord(`old:${sessionId}`, { role: 'session', sessionId });

  it('a roster-backed agent with a saved title gets the title and updates off', async () => {
    const { port } = await recoverRun(['--yes', '--json'], [], [], { seed: seedRun([rosterEntry('s-a', { title: TITLE })], [runAgent('s-a')]) });
    expect(choices(port)).toEqual([{ sessionId: 's-a', title: TITLE, disableTitleUpdates: true }]);
  });

  it('an agent with no saved title gets the label and updates on', async () => {
    const { port } = await recoverRun(['--yes', '--json'], [], [], { seed: seedRun([rosterEntry('s-a')], [runAgent('s-a')]) });
    expect(choices(port)).toEqual([{ sessionId: 's-a', title: 'repo/tree-s-a (recovered)', disableTitleUpdates: false }]);
  });

  it('a run agent that the roster does not hold has no title: it gets the label and updates on', async () => {
    const { port } = await recoverRun(['--yes', '--json'], [], [rosterEntry('s-other')], { seed: seedRun([rosterEntry('s-other')], [runAgent('s-a')]) });
    expect(choices(port).filter((s) => s.sessionId === 's-a')).toEqual([{ sessionId: 's-a', title: expect.stringContaining('(recovered)'), disableTitleUpdates: false }]);
  });
});
