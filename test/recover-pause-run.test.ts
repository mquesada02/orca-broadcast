import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRecord, RecoveryRow, Run, RunRecoveryRow, RosterEntry } from '../src/types.js';
import { agentRecord, seedOpenRun } from './helpers/fake-orca.js';
import { GONE, parseJson, recoverRun, resultsOf } from './helpers/recover.js';
import { readPointer, readRecoveries, storeDir } from './helpers/records.js';
import { agent, rosterEntry, rosterSnapshot, scanOf, seedRosters, T0 } from './helpers/roster.js';
import { runCli, type Seed } from './helpers/run-cli.js';

const LIVE = { bootId: 'boot-1', runtimeId: 'runtime-1' };
const BYPASS = '--permission-mode bypassPermissions';

// The run that the seed wrote, as it is on disk now (read synchronously, so a fake port can look at it in the middle of a run).
const readRun = (dir: string): Run => JSON.parse(readFileSync(join(storeDir(dir), 'pauses', 'run-1.json'), 'utf8')) as Run;

// A roster of the runtime that is gone, and an open pause run, in the state folder.
const seedRun =
  (entries: RosterEntry[], agents: AgentRecord[], extra: Partial<Run> = {}, capture: (dir: string) => void = () => {}): Seed =>
  async (store, dir) => {
    await seedRosters(rosterSnapshot(GONE, entries))(store);
    await seedOpenRun(store, agents, extra);
    capture(dir);
  };

// A paused agent of the run: the pane key that it had before the restart, and its session ID.
const runAgent = (sessionId: string, extra: Partial<AgentRecord> = {}): AgentRecord => agentRecord(`old:${sessionId}`, { role: 'session', sessionId, ...extra });

// An agent whose row and terminal exist from this listing number on.
const appears = (paneKey: string, from: number) => agent(paneKey, { rowAt: (n) => n >= from, terminalAt: (n) => (n >= from ? 'ok' : 'missing') });

// The scan from this scan number on holds each session on its pane.
const joined = (from: number, ...sessions: [string, string][]) => (n: number) => (n >= from ? scanOf(...sessions.map(([sessionId, paneKey]) => ({ sessionId, paneKey, startTime: 5 }))) : scanOf());

const rowsOf = (dir: string): RunRecoveryRow[] => readRun(dir).recovery?.rows ?? [];
const statusOf = (rows: RunRecoveryRow[]): Record<string, string> => Object.fromEntries(rows.map((row) => [row.sessionId, row.reason === null ? row.status : `${row.status}/${row.reason}`]));

describe('recover with an open pause run', () => {
  it('is not refused: it restarts the missing run agent, sends no prompt, writes no recovery record, and stores the starts, the key and the rows in the run', async () => {
    const { code, out, dir, port } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [], {
      seed: seedRun([rosterEntry('s-a', { permission: BYPASS })], [runAgent('s-a', { permission: BYPASS })]),
      scan: joined(3, ['s-a', 'new:a']),
    });
    expect(code).toBe(0);
    expect(port.starts).toEqual([{ worktreePath: '/work/tree-s-a', sessionId: 's-a', permission: BYPASS, title: 'repo/tree-s-a (recovered)' }]);
    expect(port.sends).toEqual([]);
    expect(readRecoveries(dir)).toEqual([]);
    const run = readRun(dir);
    expect(run.status).toBe('open');
    expect(readPointer(dir)).toEqual({ kind: 'pause', id: 'run-1' });
    expect(run.recovery).toMatchObject({ snapshotKey: GONE, liveRuntime: LIVE });
    expect(run.recovery?.starts).toEqual([{ sessionId: 's-a', startedAt: expect.any(String) }]);
    expect(statusOf(rowsOf(dir))).toEqual({ 's-a': 'restarted' });
    // The agents of the run are untouched: `resume` and `close` read only them.
    expect(run.agents[0]).toMatchObject({ paneKey: 'old:s-a', resumeStatus: 'pending' });
    const line = parseJson(out);
    expect(line).toMatchObject({ outcome: 'done', exitCode: 0, record: null });
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted' });
    expect((line as unknown as { run: Run }).run.runId).toBe('run-1');
  });

  it('writes the rows and the start before startAgent is called', async () => {
    let home = '';
    const atStart: Run[] = [];
    await recoverRun(['--yes'], [appears('new:a', 3)], [], {
      seed: seedRun([rosterEntry('s-a')], [runAgent('s-a')], {}, (d) => (home = d)),
      scan: joined(3, ['s-a', 'new:a']),
      configure: (p) => {
        p.startResultAt = (n) => {
          atStart.push(readRun(home));
          return { started: true, handle: `term_${n}` };
        };
      },
    });
    expect(atStart).toHaveLength(1);
    const before = atStart[0]?.recovery;
    expect(before?.starts).toEqual([{ sessionId: 's-a', startedAt: expect.any(String) }]);
    expect(before?.rows[0]).toMatchObject({ sessionId: 's-a', status: 'pending', reason: 'awaiting-start' });
  });

  it('stores the roster agents outside the run too: restarted with not-in-run when they were working or waiting, with no reason when done', async () => {
    const entries = [rosterEntry('s-a', { state: 'working' }), rosterEntry('s-b', { state: 'waiting' }), rosterEntry('s-c', { state: 'done' }), rosterEntry('s-d', { state: 'working' })];
    const panes: [string, string][] = ['a', 'b', 'c', 'd'].map((id) => [`s-${id}`, `new:${id}`]);
    const { code, out } = await recoverRun(['--yes', '--json'], ['a', 'b', 'c', 'd'].map((id) => appears(`new:${id}`, 6)), [], {
      seed: seedRun(entries, [runAgent('s-d')]),
      scan: joined(6, ...panes),
    });
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted/not-in-run', 's-b': 'restarted/not-in-run', 's-c': 'restarted', 's-d': 'restarted' });
  });

  it('takes the session ID of a run agent that has none from the pre-restart entry with its pane key, and reports one it cannot find as failed (no-session-id)', async () => {
    const { code, out, port, dir } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [], {
      seed: seedRun([rosterEntry('s-a')], [agentRecord('old:s-a', { role: 'session' }), agentRecord('old:lost', { role: 'session' })]),
      scan: joined(3, ['s-a', 'new:a']),
    });
    expect(code).toBe(1);
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    const rows = parseJson(out).rows;
    // The table order is by repo, worktree, then session ID (a null one last): the worktree of the lost agent sorts first.
    expect(rows.map((row) => [row.sessionId, row.status, row.reason])).toEqual([
      [null, 'failed', 'no-session-id'],
      ['s-a', 'restarted', null],
    ]);
    expect(rowsOf(dir).map((row) => row.sessionId)).toEqual(expect.arrayContaining(['s-a', null]));
  });

  it('works with no roster at all: the agents of the run are the recovery set', async () => {
    const { code, out, port } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [], {
      seed: async (store) => {
        await seedOpenRun(store, [runAgent('s-a')]);
      },
      scan: joined(3, ['s-a', 'new:a']),
    });
    expect(code).toBe(0);
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(parseJson(out).snapshots).toEqual([]);
  });

  it('finds nothing to recover for a run with no agent to recover and no roster, and writes nothing', async () => {
    const { code, out, dir } = await recoverRun(['--yes'], [], [], { seed: async (store) => void (await seedOpenRun(store, [runAgent('s-a', { resumeStatus: 'resumed' })])) });
    expect(code).toBe(0);
    expect(out).toContain('nothing to recover');
    expect(readRun(dir).recovery).toBeUndefined();
  });

  it('stores the outcomes and prints its table even when there is nothing to start', async () => {
    const { code, out, dir, port } = await recoverRun(['--yes'], [agent('new:a')], [], { seed: seedRun([rosterEntry('s-a')], [runAgent('s-a')]), scan: scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }) });
    expect(code).toBe(0);
    expect(port.starts).toEqual([]);
    expect(out).toContain('tree-s-a');
    expect(statusOf(rowsOf(dir))).toEqual({ 's-a': 'restored' });
    expect(readRun(dir).recovery?.starts).toEqual([]);
  });
});

describe('the missing workers of a coordinator', () => {
  const coordinator = rosterEntry('s-c', { role: 'coordinator', state: 'done' });
  const worker = rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-1', state: 'working' });

  it('are left to a coordinator of the run that is not failed: the row is left-to-coordinator and the list is stored on the recorded coordinator', async () => {
    const { code, out, dir, port, questions } = await recoverRun([], [appears('new:c', 3)], [], {
      seed: seedRun([coordinator, worker], [runAgent('s-c', { role: 'coordinator' })]),
      scan: joined(3, ['s-c', 'new:c']),
      ask: ['y'],
    });
    expect(code).toBe(0);
    expect(questions.join('')).toContain('Restart 1 agents, prompt 0 and leave 1 workers to their coordinators?');
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-c']);
    expect(port.sends).toEqual([]);
    expect(out).toContain('left-to-coordinator');
    expect(readRun(join(dir)).agents[0]?.missingWorkers).toEqual([{ sessionId: 's-w', repo: 'repo', worktree: 'tree-s-w', dispatchId: 'd-1' }]);
    expect(statusOf(rowsOf(dir))).toEqual({ 's-c': 'restarted', 's-w': 'left-to-coordinator' });
  });

  it('are no-coordinator (coordinator-not-paused) when the coordinator is not in the run, and no list is stored', async () => {
    const { code, out, dir } = await recoverRun(['--yes', '--json'], [appears('new:c', 3)], [], {
      seed: seedRun([coordinator, worker], [runAgent('s-other')]),
      scan: joined(3, ['s-c', 'new:c']),
    });
    expect(code).toBe(1);
    expect(resultsOf(out)['s-w']).toBe('no-coordinator/coordinator-not-paused');
    expect(readRun(dir).agents.every((a) => a.missingWorkers === undefined)).toBe(true);
  });

  it('are no-coordinator (coordinator-missing) when the coordinator is failed, and no list is stored for it', async () => {
    const { code, out, dir } = await recoverRun(['--yes', '--json'], [], [], {
      seed: seedRun([coordinator, worker], [runAgent('s-c', { role: 'coordinator' })]),
      configure: (p) => (p.startResultAt = () => ({ started: false, reason: 'invalid-session-id' })),
    });
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-c': 'failed/invalid-session-id', 's-w': 'no-coordinator/coordinator-missing' });
    expect(readRun(dir).agents[0]?.missingWorkers).toBeUndefined();
  });

  it('stay pending while their coordinator is pending, and are listed for it', async () => {
    // The coordinator is started and never appears before the timeout of the run: it is failed, so this uses a recorded start that is still young.
    const startedAt = new Date(T0 - 30_000).toISOString();
    const stored: Run['recovery'] = {
      snapshotKey: GONE,
      liveRuntime: LIVE,
      starts: [{ sessionId: 's-c', startedAt }],
      rows: [
        { ...coordinator, status: 'pending', reason: 'awaiting-start', promptDue: false, messagePending: false, baseline: null, startedAt },
        { ...worker, status: 'pending', reason: 'timed-out', promptDue: false, messagePending: false, baseline: null, listDue: true },
      ],
    };
    const { code, out, dir, port } = await recoverRun(['--yes', '--json', '--timeout', '5s'], [], [], {
      seed: seedRun([coordinator, worker], [runAgent('s-c', { role: 'coordinator' })], { recovery: stored }),
    });
    expect(code).toBe(1);
    expect(port.starts).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-c': 'pending/awaiting-start', 's-w': 'pending/timed-out' });
    expect(readRun(dir).agents[0]?.missingWorkers).toEqual([{ sessionId: 's-w', repo: 'repo', worktree: 'tree-s-w', dispatchId: 'd-1' }]);
  });

  it('are not listed for the self session, whose workers are printed on its self line', async () => {
    const { out, dir } = await recoverRun(['--yes'], [agent('self:1')], [], {
      seed: seedRun([coordinator, worker], [runAgent('s-c', { role: 'coordinator' })]),
      scan: scanOf({ sessionId: 's-c', paneKey: 'self:1', startTime: 5 }),
      env: { ORCA_PANE_KEY: 'self:1' },
    });
    expect(out).toContain('missing workers: repo/tree-s-w (dispatch d-1)');
    expect(readRun(dir).agents[0]?.missingWorkers).toBeUndefined();
  });
});

describe('the self session that is an agent of the run', () => {
  it('is found by the pane key of its run record when the scan has no record for that pane: it is no row, gets no list, and its worker is coordinator-is-self', async () => {
    const coordinator = rosterEntry('s-c', { role: 'coordinator', state: 'done', paneKey: 'old:s-c' });
    const worker = rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-1' });
    const { out, dir } = await recoverRun(['--yes', '--json'], [agent('self:1')], [], {
      seed: seedRun([coordinator, worker], [agentRecord('self:1', { role: 'coordinator', sessionId: 's-c' })]),
      env: { ORCA_PANE_KEY: 'self:1' },
    });
    expect(resultsOf(out)).toEqual({ 's-w': 'no-coordinator/coordinator-is-self' });
    expect(readRun(dir).agents[0]?.missingWorkers).toBeUndefined();
  });
});

describe('a declined confirmation', () => {
  it('writes nothing to the run, and shows the rows that would have been started as pending (declined)', async () => {
    const { code, out, dir, port } = await recoverRun([], [], [], { seed: seedRun([rosterEntry('s-a')], [runAgent('s-a')]), ask: ['n'] });
    expect(code).toBe(1);
    expect(port.starts).toEqual([]);
    expect(out).toContain('declined');
    expect(readRun(dir).recovery).toBeUndefined();
  });
});

describe('a later recover on the same run', () => {
  const stored = (rows: Partial<RecoveryRow>[], starts: { sessionId: string; startedAt: string }[] = [], liveRuntime = LIVE): NonNullable<Run['recovery']> => ({
    snapshotKey: GONE,
    liveRuntime,
    starts,
    rows: rows.map((row) => ({ ...rosterEntry(row.sessionId as string), status: 'restarted', reason: null, promptDue: false, messagePending: false, baseline: null, ...row })),
  });

  it('takes again only the failed, no-coordinator and pending rows of its last recover; the others keep their outcome', async () => {
    const recovery = stored([
      { sessionId: 's-a', status: 'failed', reason: 'did-not-appear' },
      { sessionId: 's-b', status: 'restarted' },
      { sessionId: 's-c', status: 'restored' },
    ]);
    const { code, out, dir, port } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [], {
      seed: seedRun([rosterEntry('s-a'), rosterEntry('s-b'), rosterEntry('s-c')], [runAgent('s-a')], { recovery }),
      scan: joined(3, ['s-a', 'new:a']),
    });
    expect(code).toBe(0);
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted' });
    expect(statusOf(rowsOf(dir))).toEqual({ 's-a': 'restarted', 's-b': 'restarted', 's-c': 'restored' });
  });

  it('computes the list of a coordinator again from the current rows: a worker that comes back drops out, and a coordinator that fails loses its list', async () => {
    const coordinator = rosterEntry('s-c', { role: 'coordinator', state: 'done' });
    const worker = rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-c', dispatchId: 'd-1' });
    const recovery = stored([
      { ...coordinator, status: 'pending', reason: 'timed-out' },
      { ...worker, status: 'pending', reason: 'timed-out', listDue: true },
    ]);
    const { code, out, dir } = await recoverRun(['--yes', '--json'], [], [], {
      seed: seedRun([coordinator, worker], [runAgent('s-c', { role: 'coordinator', missingWorkers: [{ sessionId: 's-w', repo: 'repo', worktree: 'tree-s-w', dispatchId: 'd-1' }] })], { recovery }),
      configure: (p) => (p.startResultAt = () => ({ started: false, reason: 'invalid-session-id' })),
    });
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-c': 'failed/invalid-session-id', 's-w': 'no-coordinator/coordinator-missing' });
    expect(readRun(dir).agents[0]?.missingWorkers).toBeUndefined();
  });

  it('drops the stored starts when the live runtime changed, says so, and recovers the run anew', async () => {
    const recovery = stored([{ sessionId: 's-a', status: 'restarted' }], [{ sessionId: 's-a', startedAt: new Date(T0 - 30_000).toISOString() }], { bootId: 'boot-0', runtimeId: 'runtime-9' });
    const { out, dir, port } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [], {
      seed: seedRun([rosterEntry('s-a')], [runAgent('s-a')], { recovery }),
      scan: joined(3, ['s-a', 'new:a']),
    });
    expect(parseJson(out).warnings).toContain('the fleet restarted again; dropped 1 recorded starts');
    expect(port.starts.map((s) => s.sessionId)).toEqual(['s-a']);
    expect(readRun(dir).recovery).toMatchObject({ liveRuntime: LIVE });
    expect(readRun(dir).recovery?.starts).toHaveLength(1);
  });

  it('waits for a start that was recorded before an interruption and whose agent is not live yet, and starts nothing again when the agent appears', async () => {
    const startedAt = new Date(T0 - 10_000).toISOString();
    const recovery = stored([{ sessionId: 's-a', status: 'pending', reason: 'awaiting-start', startedAt }], [{ sessionId: 's-a', startedAt }]);
    const { code, out, port } = await recoverRun(['--yes', '--json'], [appears('new:a', 2)], [], {
      seed: seedRun([rosterEntry('s-a')], [runAgent('s-a')], { recovery }),
      scan: (n) => (n >= 2 ? scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }) : scanOf()),
    });
    expect(code).toBe(0);
    expect(port.starts).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted' });
  });

  it('keeps the row pending (awaiting-start) and the start in the run when --timeout ends while the start is under 2 minutes old', async () => {
    const startedAt = new Date(T0 - 60_000).toISOString();
    const recovery = stored([{ sessionId: 's-a', status: 'pending', reason: 'awaiting-start', startedAt }], [{ sessionId: 's-a', startedAt }]);
    const { code, out, dir, port } = await recoverRun(['--yes', '--json', '--timeout', '5s'], [], [], { seed: seedRun([rosterEntry('s-a')], [runAgent('s-a')], { recovery }) });
    expect(code).toBe(1);
    expect(port.starts).toEqual([]);
    expect(resultsOf(out)).toEqual({ 's-a': 'pending/awaiting-start' });
    expect(readRun(dir).status).toBe('open');
    expect(readRun(dir).recovery?.starts).toEqual([{ sessionId: 's-a', startedAt }]);
  });

  it('does not retake a recovery record that closed earlier in the same restart', async () => {
    const { out, port } = await recoverRun(['--yes', '--json'], [appears('new:a', 3)], [], {
      seed: async (store, dir) => {
        await seedRun([rosterEntry('s-a')], [runAgent('s-a')])(store, dir);
        await store.saveRecovery({ id: 'r0', token: 't', createdAt: '2026-01-02T00:00:00.000Z', status: 'closed', endedBy: 'done', snapshotKey: GONE, liveRuntime: LIVE, snapshots: [], rows: [] });
      },
      scan: joined(3, ['s-a', 'new:a']),
    });
    expect(resultsOf(out)).toEqual({ 's-a': 'restarted' });
    expect(port.starts).toHaveLength(1);
  });
});

describe('the rows that recover stored in the run', () => {
  const recovery: NonNullable<Run['recovery']> = {
    snapshotKey: GONE,
    liveRuntime: LIVE,
    starts: [{ sessionId: 's-a', startedAt: '2026-01-01T00:00:00.000Z' }],
    rows: [{ ...rosterEntry('s-a'), status: 'failed', reason: 'did-not-appear', promptDue: false, messagePending: false, baseline: null }],
  };

  it.each(['close', 'resume --yes'])('are never acted on or changed by %s, and stay on the closed run', async (command) => {
    const { dir } = await runCli(command.split(' '), [], { seed: seedRun([rosterEntry('s-a')], [runAgent('s-a')], { recovery }) });
    expect(readRun(dir).status).toBe('closed');
    expect(readRun(dir).recovery).toEqual(recovery);
  });
});

describe('the repair of an open pause run', () => {
  it('abandons a broadcast that is open beside the run, with its note', async () => {
    const { err, dir } = await recoverRun(['--yes'], [agent('new:a')], [], {
      seed: async (store, d) => {
        await seedRun([rosterEntry('s-a')], [runAgent('s-a')])(store, d);
        await store.saveBroadcast({ id: 'b-1', token: 'abcd1234', text: 't', createdAt: '2026-01-01T00:00:00.000Z', status: 'open', targets: [] });
      },
      scan: scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }),
    });
    expect(err).toContain('broadcast b-1 was open beside a pause run and is now abandoned');
    expect(existsSync(join(storeDir(dir), 'broadcasts', 'b-1.json'))).toBe(true);
  });

  it('refuses a run that was written by an older version, with the existing message', async () => {
    const { code, err } = await recoverRun(['--yes'], [], [], { seed: seedRun([rosterEntry('s-a')], [runAgent('s-a')], { scope: undefined as unknown as Run['scope'] }) });
    expect(code).toBe(2);
    expect(err).toContain('the open run was written by an older version of orca-broadcast');
  });
});
