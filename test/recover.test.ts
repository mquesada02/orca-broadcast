import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agent, rosterEntry, scanOf } from './helpers/roster.js';
import { doneEntry, parseJson, recoverRun, resultsOf } from './helpers/recover.js';
import { CTRL_C } from './helpers/run-cli.js';

const BYPASS = '--permission-mode bypassPermissions';
const QUESTION = (n: number, m: number, k: number) => `Restart ${n} agents, prompt ${m} and leave ${k} workers to their coordinators? [y/N] `;

describe('classification', () => {
  it('restored with no prompt due: exit 0, no question, the pane key is not the identity', async () => {
    const { code, out, port, questions } = await recoverRun(['--yes', '--json'], [agent('new:a')], [doneEntry('s-a', { paneKey: 'old:a' })], {
      scan: scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }),
    });
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-a': 'restored' });
    expect(questions).toEqual([]);
    expect(port.starts).toEqual([]);
    expect(port.sends).toEqual([]);
  });

  it('a missing agent (no process holds its session) is started after yes; one that never appears ends failed did-not-appear, and nothing is sent', async () => {
    const { code, out, port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')]);
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/did-not-appear' });
    expect(port.starts).toEqual([{ worktreePath: '/work/tree-s-a', sessionId: 's-a', permission: null, title: 'repo/tree-s-a (recovered)', disableTitleUpdates: false }]);
    expect(port.sends).toEqual([]);
    // The first scan, the scan before the start, and the end roster save.
    expect(port.scanCalls).toBe(3);
  });

  it('a session held by a process outside Orca is failed session-held after 60 seconds', async () => {
    const { code, out, clock, port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { scan: scanOf({ sessionId: 's-a', paneKey: null }) });
    expect(code).toBe(1);
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/session-held' });
    expect(clock.slept).toBe(60_000);
    expect(port.scanCalls).toBe(31);
  });

  it('a session that a shell is about to resume (heldByOthers) counts as held', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { scan: { sessions: [], unknown: [], heldByOthers: ['s-a'] } });
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/session-held' });
  });

  it('a held session that appears in Orca during the re-check becomes restored', async () => {
    const { code, out, clock } = await recoverRun(['--yes', '--json'], [agent('new:a')], [doneEntry('s-a')], {
      scan: (n) => scanOf({ sessionId: 's-a', paneKey: n === 1 ? null : 'new:a', startTime: 5 }),
    });
    expect(code).toBe(0);
    expect(resultsOf(out)).toEqual({ 's-a': 'restored' });
    expect(clock.slept).toBe(2000);
  });

  it('a held session whose holder ends becomes missing', async () => {
    const { out, port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { scan: (n) => (n === 1 ? scanOf({ sessionId: 's-a', paneKey: null }) : scanOf()) });
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/did-not-appear' });
    expect(port.starts).toHaveLength(1);
  });

  it('a --timeout shorter than 60 seconds ends the re-check at the timeout', async () => {
    const { out, clock } = await recoverRun(['--yes', '--json', '--timeout', '9s'], [], [doneEntry('s-a')], { scan: scanOf({ sessionId: 's-a', paneKey: null }) });
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/session-held' });
    expect(clock.slept).toBe(9000);
  });

  it('a session held through a terminal that locate rejects is held, not restored', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [agent('new:a', { orphaned: true })], [doneEntry('s-a')], { scan: scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }) });
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/session-held' });
  });

  it.each([
    ['a claude process whose folder is unknown', { cwd: null }],
    ['a claude process in the worktree', { cwd: '/work/tree-s-a' }],
    ['a claude process in a folder under the worktree', { cwd: '/work/tree-s-a/packages/x' }],
  ])('%s makes the agent unverifiable and never missing', async (_name, unknown) => {
    const { out } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { scan: { sessions: [], unknown: [unknown], heldByOthers: [] } });
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/unverifiable' });
  });

  it('a claude process of unknown session in a sibling folder does not block the agent', async () => {
    const { out, port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { scan: { sessions: [], unknown: [{ cwd: '/work/tree-s-a-other' }], heldByOthers: [] } });
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/did-not-appear' });
    expect(port.starts).toHaveLength(1);
  });

  it('a held agent becomes unverifiable when an unknown process appears in its folder', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], {
      scan: (n) => (n === 1 ? scanOf({ sessionId: 's-a', paneKey: null }) : { sessions: [], unknown: [{ cwd: null }], heldByOthers: [] }),
    });
    expect(resultsOf(out)).toEqual({ 's-a': 'failed/unverifiable' });
  });

  it('a scan that fails in the re-check fails the held rows and every missing non-worker at once: no restart is listed, so nothing is asked, and "declined" never shows', async () => {
    const entries = [doneEntry('s-held'), doneEntry('s-gone'), doneEntry('s-w', { role: 'worker', coordinatorSessionId: 's-gone' })];
    const { code, out, questions, port } = await recoverRun([], [], entries, {
      ask: ['n'],
      scan: scanOf({ sessionId: 's-held', paneKey: null }),
      configure: (p) => (p.failScansFrom = 2),
    });
    expect(code).toBe(1);
    expect(questions).toEqual([]);
    expect(port.starts).toEqual([]);
    expect(out).toMatch(/tree-s-gone\s+session\s+failed\s+scan-failed/);
    expect(out).toMatch(/tree-s-held\s+session\s+failed\s+scan-failed/);
    expect(out).toMatch(/tree-s-w\s+worker\s+no-coordinator\s+coordinator-missing/);
    expect(out).not.toContain('declined');
  });
});

describe('self', () => {
  const entries = [doneEntry('s-self'), doneEntry('s-other')];
  const scan = scanOf({ sessionId: 's-self', paneKey: 'new:self', startTime: 5 });

  it('is never a row, and shows on its own line when another row exists', async () => {
    const { code, out, err } = await recoverRun(['--yes'], [agent('new:self')], entries, { scan, env: { ORCA_PANE_KEY: 'new:self' } });
    expect(code).toBe(1);
    expect(err).toBe('');
    expect(out).toContain('self (not restarted or prompted) — this session runs recover');
    expect(out).toMatch(/tree-s-other\s+session\s+failed\s+did-not-appear/);
    expect(out.match(/tree-s-self/g)).toHaveLength(1);
    expect(out).not.toContain('missing workers:');
  });

  it('is found by the session ID of the scan record when the entry kept an old pane key, and is not in --json', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [agent('new:self')], entries, { scan, env: { ORCA_PANE_KEY: 'new:self' } });
    expect(Object.keys(resultsOf(out))).toEqual(['s-other']);
    expect(out).not.toContain('self');
  });

  it('is still self when its live row has no session record: the self line comes from the live row and nothing crashes', async () => {
    const { code, out } = await recoverRun(['--yes'], [agent('new:self', { worktree: 'live-tree' })], [doneEntry('s-other')], { env: { ORCA_PANE_KEY: 'new:self' } });
    expect(code).toBe(1);
    expect(out).toMatch(/self \(not restarted or prompted\)[\s\S]*live-tree\s+session/);
  });

  it('is nothing to recover when the set holds only the self session, with no self line', async () => {
    const { code, out } = await recoverRun(['--yes'], [agent('new:self')], [doneEntry('s-self')], { scan, env: { ORCA_PANE_KEY: 'new:self' } });
    expect(code).toBe(0);
    expect(out).toMatch(/nothing to recover\n$/);
    expect(out).not.toContain('self (');
  });

  it.each([[undefined], ['']])('does not exist when ORCA_PANE_KEY is %j: every row is handled', async (key) => {
    const { out } = await recoverRun(['--yes', '--json'], [], entries, { env: key === undefined ? {} : { ORCA_PANE_KEY: key } });
    expect(resultsOf(out)).toEqual({ 's-self': 'failed/did-not-appear', 's-other': 'failed/did-not-appear' });
  });

  it('with an unknown ORCA_PANE_KEY there is no self line, and the entry its own process holds ends failed session-held', async () => {
    const { out } = await recoverRun(['--yes'], [], entries, { scan: scanOf({ sessionId: 's-self', paneKey: null }), env: { ORCA_PANE_KEY: 'nowhere:1' } });
    expect(out).not.toContain('self (');
    expect(out).toMatch(/tree-s-self\s+session\s+failed\s+session-held/);
  });

  it('a self coordinator: its missing workers are no-coordinator rows (exit 1) and are listed on the self line', async () => {
    const coordinator = doneEntry('s-coord', { role: 'coordinator' });
    const workers = [
      rosterEntry('s-w1', { role: 'worker', coordinatorSessionId: 's-coord', dispatchId: 'd-1' }),
      rosterEntry('s-w2', { role: 'worker', coordinatorSessionId: 's-coord' }),
    ];
    const run = { scan: scanOf({ sessionId: 's-coord', paneKey: 'new:c', startTime: 5 }), env: { ORCA_PANE_KEY: 'new:c' } };
    const text = await recoverRun(['--yes'], [agent('new:c')], [coordinator, ...workers], run);
    expect(text.code).toBe(1);
    expect(text.out).toContain('missing workers: repo/tree-s-w1 (dispatch d-1); repo/tree-s-w2 (dispatch unknown)');
    expect(text.out).toMatch(/tree-s-w1\s+worker\s+no-coordinator\s+coordinator-is-self/);
    const json = await recoverRun(['--yes', '--json'], [agent('new:c')], [coordinator, ...workers], run);
    expect(parseJson(json.out).rows.map((row) => [row.sessionId, row.dispatchId])).toEqual([['s-w1', 'd-1'], ['s-w2', null]]);
  });
});

describe('missing workers', () => {
  const worker = (id: string, coordinator?: string) => rosterEntry(id, { role: 'worker', ...(coordinator === undefined ? {} : { coordinatorSessionId: coordinator }) });
  const coordinatorEntry = doneEntry('s-coord', { role: 'coordinator' });
  const live = scanOf({ sessionId: 's-coord', paneKey: 'new:c', startTime: 5 });

  it('is never restarted; its restored coordinator is prompted with the list and the worker is left to it', async () => {
    const { out, port } = await recoverRun(['--yes', '--json'], [agent('new:c')], [coordinatorEntry, worker('s-w', 's-coord')], { scan: live });
    expect(resultsOf(out)).toEqual({ 's-coord': 'pending/still-working', 's-w': 'left-to-coordinator' });
    expect(port.starts).toEqual([]);
  });

  it('has no coordinator when none is recorded, or the recorded one is not in the pre-restart set', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [worker('s-w1'), worker('s-w2', 's-unknown')]);
    expect(resultsOf(out)).toEqual({ 's-w1': 'no-coordinator/coordinator-missing', 's-w2': 'no-coordinator/coordinator-missing' });
  });

  it('has coordinator-filtered when the filters removed the coordinator', async () => {
    const { out } = await recoverRun(['--yes', '--json', '--role', 'worker'], [], [coordinatorEntry, worker('s-w', 's-coord')]);
    expect(resultsOf(out)).toEqual({ 's-w': 'no-coordinator/coordinator-filtered' });
  });

  it('has coordinator-missing when the coordinator is failed', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [coordinatorEntry, worker('s-w', 's-coord')], { scan: { sessions: [], unknown: [{ cwd: '/work/tree-s-coord' }], heldByOthers: [] } });
    expect(resultsOf(out)).toEqual({ 's-coord': 'failed/unverifiable', 's-w': 'no-coordinator/coordinator-missing' });
  });

  it('a worker that is itself missing cannot be the coordinator of another worker', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [worker('s-w1', 's-w2'), worker('s-w2')]);
    expect(resultsOf(out)).toEqual({ 's-w1': 'no-coordinator/coordinator-missing', 's-w2': 'no-coordinator/coordinator-missing' });
  });

  it('a restored worker is handled like any live agent: restored, and a prompt only when it was working', async () => {
    const entries = [doneEntry('s-wd', { role: 'worker' }), rosterEntry('s-ww', { role: 'worker' })];
    const { out } = await recoverRun(['--yes', '--json'], [agent('new:d'), agent('new:w')], entries, {
      scan: scanOf({ sessionId: 's-wd', paneKey: 'new:d', startTime: 5 }, { sessionId: 's-ww', paneKey: 'new:w', startTime: 6 }),
    });
    expect(resultsOf(out)).toEqual({ 's-wd': 'restored', 's-ww': 'pending/still-working' });
  });

  it('a restored coordinator that was done and has no missing worker is restored, with no prompt', async () => {
    const quiet = await recoverRun(['--yes', '--json'], [agent('new:c')], [coordinatorEntry], { scan: live });
    expect(resultsOf(quiet.out)).toEqual({ 's-coord': 'restored' });
  });
});

describe('confirmation', () => {
  const entries = [
    doneEntry('s-coord', { role: 'coordinator' }),
    rosterEntry('s-a', { permission: BYPASS }),
    doneEntry('s-b'),
    rosterEntry('s-live'),
    rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-coord' }),
  ];
  const scan = scanOf({ sessionId: 's-coord', paneKey: 'new:c', startTime: 5 }, { sessionId: 's-live', paneKey: 'new:l', startTime: 6 });
  const agents = [agent('new:c', { worktree: 'wc' }), agent('new:l', { worktree: 'wl' })];

  it('lists restart, prompt and leave lines in table order with the permission flag, and asks the fixed question with the three counts', async () => {
    const { err, questions } = await recoverRun([], agents, entries, { ask: ['n'], scan });
    expect(err).toBe(
      [
        `  restart repo/tree-s-a (session) ${BYPASS}`,
        '  restart repo/tree-s-b (session) no permission flag',
        '  prompt repo/tree-s-coord (coordinator)',
        '  prompt repo/tree-s-a (session)',
        '  prompt repo/tree-s-live (session)',
        '  leave repo/tree-s-w to repo/tree-s-coord',
        '',
      ].join('\n'),
    );
    expect(questions).toEqual([QUESTION(2, 3, 1)]);
  });

  it('"no" prints the report with pending/declined rows, starts and sends nothing, writes no record, and exits 1', async () => {
    const { code, out, port, dir } = await recoverRun([], agents, entries, { ask: ['n'], scan });
    expect(code).toBe(1);
    expect(port.starts).toEqual([]);
    expect(port.sends).toEqual([]);
    expect(out).toMatch(/tree-s-coord\s+coordinator\s+pending\s+declined/);
    expect(out).toMatch(/tree-s-a\s+session\s+pending\s+declined/);
    expect(out).toMatch(/tree-s-b\s+session\s+pending\s+declined/);
    expect(out).toMatch(/tree-s-live\s+session\s+pending\s+declined/);
    expect(out).toMatch(/tree-s-w\s+worker\s+pending\s+declined/);
    expect((await readdir(join(dir, 'orca-broadcast'))).sort()).toEqual(['roster']);
  });

  it('"no" keeps the rows that need nothing: failed rows and no-coordinator rows keep their result', async () => {
    const { out } = await recoverRun(['--json', '--yes'], [], [rosterEntry('s-x', { role: 'worker' }), doneEntry('s-held')], { scan: scanOf({ sessionId: 's-held', paneKey: null }) });
    expect(resultsOf(out)).toEqual({ 's-x': 'no-coordinator/coordinator-missing', 's-held': 'failed/session-held' });
  });

  it('"yes" restarts the missing agents and prompts the live ones: a restart that never appears is failed, and the prompted rows wait for their ack', async () => {
    const { code, out, port, questions } = await recoverRun([], agents, entries, { ask: ['y'], scan });
    expect(code).toBe(1);
    expect(questions).toHaveLength(1);
    expect(port.starts.map((start) => [start.sessionId, start.permission])).toEqual([['s-a', BYPASS], ['s-b', null]]);
    expect(port.sends.map((send) => send.handle)).toEqual(['term_new:c', 'term_new:l']);
    expect(out.match(/failed\s+did-not-appear/g)).toHaveLength(2);
    expect(out.match(/pending\s+still-working/g)).toHaveLength(2);
    expect(out.match(/left-to-coordinator/g)).toHaveLength(1);
  });

  it('--yes asks nothing and gives the same rows', async () => {
    const { questions, out } = await recoverRun(['--yes'], agents, entries, { scan });
    expect(questions).toEqual([]);
    expect(out.match(/failed\s+did-not-appear/g)).toHaveLength(2);
    expect(out.match(/pending\s+still-working/g)).toHaveLength(2);
  });

  it('asks nothing when it would list nothing', async () => {
    const { code, questions, err } = await recoverRun([], [agent('new:a')], [doneEntry('s-a')], { ask: ['n'], scan: scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }) });
    expect(code).toBe(0);
    expect(questions).toEqual([]);
    expect(err).toBe('');
  });

  it('a prompt line is listed for a restored coordinator only because of its missing workers', async () => {
    const { err } = await recoverRun([], [agent('new:c', { worktree: 'wc' })], [doneEntry('s-coord', { role: 'coordinator' }), rosterEntry('s-w', { role: 'worker', coordinatorSessionId: 's-coord' })], {
      ask: ['n'],
      scan: scanOf({ sessionId: 's-coord', paneKey: 'new:c', startTime: 5 }),
    });
    expect(err).toBe('  prompt repo/tree-s-coord (coordinator)\n  leave repo/tree-s-w to repo/tree-s-coord\n');
  });

  it('Ctrl-C at the prompt is an interrupt: exit 130, nothing started or sent', async () => {
    const { code, err, port } = await recoverRun([], agents, entries, { ask: [CTRL_C], scan });
    expect(code).toBe(130);
    expect(err).toContain('interrupted by SIGINT');
    expect(port.starts).toEqual([]);
    expect(port.sends).toEqual([]);
  });
});

describe('signals', () => {
  it('SIGTERM during the held re-check is exit 130, outcome error, rows [] and the snapshots read so far', async () => {
    const signals = new EventEmitter();
    const { code, out } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], {
      signals,
      scan: scanOf({ sessionId: 's-a', paneKey: null }),
      onSleep: () => signals.emit('SIGTERM'),
    });
    expect(code).toBe(130);
    const line = parseJson(out);
    expect([line.outcome, line.exitCode, line.error, line.rows]).toEqual(['error', 130, 'interrupted by SIGTERM', []]);
    expect(line.snapshots).toHaveLength(1);
  });
});
