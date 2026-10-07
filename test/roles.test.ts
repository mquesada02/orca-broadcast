import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pause, pauseMessage } from '../src/pause.js';
import { continueMessage, resume } from '../src/resume.js';
import { createRecordStore } from '../src/store.js';
import type { AgentRecord, Run, RunRow } from '../src/types.js';
import { type FakeAgent, agentRecord, fakeClock, FakeOrca, pausedDone, repliesWithToken, seedOpenRun, tempStateDir, working } from './helpers/fake-orca.js';
import { runCli } from './helpers/run-cli.js';

const TOKEN = 'abcd1234';

async function setupPause(agents: FakeAgent[], selfPaneKey?: string) {
  const dir = await tempStateDir();
  const port = new FakeOrca(agents);
  const run = (timeoutMs = 60_000) => pause(timeoutMs, { port, clock: fakeClock(), store: createRecordStore(dir), newToken: () => TOKEN, selfPaneKey });
  const readRun = async (): Promise<Run> => {
    const file = (await readdir(dir)).find((n) => n.endsWith('.json')) ?? '';
    return JSON.parse(await readFile(join(dir, file), 'utf8')) as Run;
  };
  return { port, run, readRun };
}

const rolesOf = (run: Run) => Object.fromEntries(run.agents.map((a) => [a.paneKey, a.role]));
const idsOf = (run: Run) => Object.fromEntries(run.agents.map((a) => [a.paneKey, a.orchestrationRunIds]));
const runRow = (port: FakeOrca, id: string, paneKey: string | null): RunRow => ({ id, coordinatorHandle: paneKey === null ? null : port.handleOf(paneKey) });

describe('roles after an Orca restart', () => {
  it('finds a done coordinator that is not in the record through its children, and gives the workers their roles', async () => {
    const { port, run, readRun } = await setupPause([
      { paneKey: 'c:1', behavior: pausedDone() },
      { paneKey: 'w:1', parentPaneKey: 'c:1', behavior: repliesWithToken() },
      { paneKey: 'w:2', parentPaneKey: 'c:1', behavior: repliesWithToken() },
      { paneKey: 's:1', behavior: repliesWithToken() },
    ]);
    // After a restart: no active worker rows, and the only run-list row has a handle that matches no terminal.
    port.runsAt = () => [{ id: 'run_gone', coordinatorHandle: 'term_stale' }];
    const summary = await run();
    expect(summary.exitCode).toBe(0);
    expect(rolesOf(await readRun())).toEqual({ 'w:1': 'worker', 'w:2': 'worker', 's:1': 'session' });
    expect(port.sendsTo('c:1')).toBe(0);
    expect(port.sends.map((s) => s.text)).toEqual([pauseMessage(TOKEN), pauseMessage(TOKEN), pauseMessage(TOKEN)]);
  });

  it('gives a live worker the run id it carries although the run-list handle of its coordinator is stale', async () => {
    const { port, run, readRun } = await setupPause([
      { paneKey: 'c:1', behavior: pausedDone() },
      { paneKey: 'w:1', parentPaneKey: 'c:1', behavior: repliesWithToken() },
      { paneKey: 'w:2', parentPaneKey: 'c:1', behavior: repliesWithToken() },
    ]);
    port.runsAt = () => [{ id: 'run_B', coordinatorHandle: 'term_stale' }];
    port.workersAt = () => [{ paneKey: 'w:1', runId: 'run_B' }];
    await run();
    expect(idsOf(await readRun())).toEqual({ 'w:1': ['run_B'], 'w:2': [] });
  });
});

describe('role rules', () => {
  const roles = async (agents: FakeAgent[], configure: (port: FakeOrca) => void = () => {}) => {
    const t = await setupPause(agents);
    configure(t.port);
    await t.run(5000);
    return rolesOf(await t.readRun());
  };

  it('makes the agent a coordinator when its handle is a run coordinator handle, and a worker with an active worker row, else a session', async () => {
    const result = await roles(
      [
        { paneKey: 'c:1', behavior: working },
        { paneKey: 'w:2', behavior: working },
        { paneKey: 's:3', behavior: working },
      ],
      (port) => {
        port.coordinatorsAt = () => ['c:1'];
        port.workersAt = () => [{ paneKey: 'w:2' }];
      },
    );
    expect(result).toEqual({ 'c:1': 'coordinator', 'w:2': 'worker', 's:3': 'session' });
  });

  it('lets coordinator win when an agent is a worker and also has a child', async () => {
    const result = await roles(
      [
        { paneKey: 'm:1', behavior: working },
        { paneKey: 'k:2', parentPaneKey: 'm:1', behavior: working },
      ],
      (port) => {
        port.workersAt = () => [{ paneKey: 'm:1' }];
      },
    );
    expect(result).toEqual({ 'm:1': 'coordinator', 'k:2': 'worker' });
  });

  it('ignores a parent link to the own pane', async () => {
    expect(await roles([{ paneKey: 'a:1', parentPaneKey: 'a:1', behavior: working }])).toEqual({ 'a:1': 'session' });
  });

  it('makes both agents of a parent cycle coordinators', async () => {
    const result = await roles([
      { paneKey: 'a:1', parentPaneKey: 'b:2', behavior: working },
      { paneKey: 'b:2', parentPaneKey: 'a:1', behavior: working },
    ]);
    expect(result).toEqual({ 'a:1': 'coordinator', 'b:2': 'coordinator' });
  });

  it('keeps a session when its parent link names no live agent', async () => {
    const result = await roles([
      { paneKey: 'a:1', parentPaneKey: 'missing:9', behavior: working },
      { paneKey: 'b:2', parentPaneKey: 'c:3', behavior: working },
      { paneKey: 'c:3', hasTerminal: false, behavior: working },
    ]);
    expect(result['a:1']).toBe('session');
    expect(result['b:2']).toBe('session');
  });

  it('does not count a link from a row whose terminal is gone', async () => {
    const result = await roles([
      { paneKey: 'p:1', behavior: working },
      { paneKey: 'k:2', parentPaneKey: 'p:1', hasTerminal: false, behavior: working },
    ]);
    expect(result['p:1']).toBe('session');
  });

  it('does not use a worker-list row whose handle matches no live terminal', async () => {
    const result = await roles([{ paneKey: 'a:1', behavior: working }], (port) => {
      port.workersAt = () => [{ paneKey: 'z:9', runId: 'run_z' }];
    });
    expect(result).toEqual({ 'a:1': 'session' });
  });

  it('counts the pane of the session that runs the command as live, so its children make it a coordinator', async () => {
    const t = await setupPause(
      [
        { paneKey: 's:1', behavior: working },
        { paneKey: 'w:1', parentPaneKey: 's:1', behavior: repliesWithToken() },
      ],
      's:1',
    );
    const summary = await t.run();
    expect(summary.self?.role).toBe('coordinator');
    expect(t.port.sendsTo('s:1')).toBe(0);
    expect(rolesOf(await t.readRun())).toEqual({ 'w:1': 'worker', 's:1': 'coordinator' });
  });

  it('gives a new entry that fails the locate step role session and no run ids, though run-list names its pane', async () => {
    const t = await setupPause([{ paneKey: 'a:1', hasTerminal: false, behavior: working }]);
    t.port.coordinatorsAt = () => ['a:1'];
    await t.run(5000);
    expect((await t.readRun()).agents[0]).toMatchObject({ resumeStatus: 'gone', role: 'session', orchestrationRunIds: [] });
  });

  it('sends a session the plain pause message without the do-not-dispatch sentence', async () => {
    const t = await setupPause([{ paneKey: 's:1', behavior: repliesWithToken() }]);
    await t.run();
    expect(t.port.sends.map((s) => s.text)).toEqual([pauseMessage(TOKEN)]);
    expect(pauseMessage(TOKEN, 'session')).toBe(pauseMessage(TOKEN));
  });
});

describe('orchestration run ids', () => {
  const idsAfterPause = async (agents: FakeAgent[], configure: (port: FakeOrca) => void) => {
    const t = await setupPause(agents);
    configure(t.port);
    await t.run(5000);
    return idsOf(await t.readRun());
  };

  it('unions run-list and worker-list ids by handle, sorted and without duplicates, whatever the order of the rows', async () => {
    const ids = await idsAfterPause([{ paneKey: 'a:1', behavior: working }], (port) => {
      port.runsAt = () => [runRow(port, 'run_b', 'a:1'), runRow(port, 'run_a', 'a:1'), runRow(port, 'run_b', 'a:1')];
      port.workersAt = () => [{ paneKey: 'a:1', runId: 'run_a' }, { paneKey: 'a:1', runId: 'run_c' }];
    });
    expect(ids).toEqual({ 'a:1': ['run_a', 'run_b', 'run_c'] });
  });

  it('skips a run-list row with a null coordinator handle, and lets a worker row with a null run id mark a worker without adding an id', async () => {
    const t = await setupPause([{ paneKey: 'a:1', behavior: working }]);
    t.port.runsAt = () => [runRow(t.port, 'run_null', null)];
    t.port.workersAt = () => [{ paneKey: 'a:1', runId: null }];
    await t.run(5000);
    expect((await t.readRun()).agents[0]).toMatchObject({ role: 'worker', orchestrationRunIds: [] });
  });

  it('lets a worker without a run of its own inherit a copy of the run ids of its parent', async () => {
    const ids = await idsAfterPause(
      [
        { paneKey: 'c:1', behavior: working },
        { paneKey: 'w:2', parentPaneKey: 'c:1', behavior: working },
      ],
      (port) => {
        port.runsAt = () => [runRow(port, 'run_A', 'c:1')];
      },
    );
    expect(ids).toEqual({ 'c:1': ['run_A'], 'w:2': ['run_A'] });
  });

  it('keeps the own ids of a worker and does not inherit one hop further', async () => {
    const ids = await idsAfterPause(
      [
        { paneKey: 'c:1', behavior: working },
        { paneKey: 'm:2', parentPaneKey: 'c:1', behavior: working },
        { paneKey: 'w:3', parentPaneKey: 'm:2', behavior: working },
        { paneKey: 'k:4', parentPaneKey: 'c:1', behavior: working },
      ],
      (port) => {
        port.runsAt = () => [runRow(port, 'run_A', 'c:1')];
        port.workersAt = () => [{ paneKey: 'k:4', runId: 'run_own' }];
      },
    );
    // m:2 is a coordinator (w:3 points at it), so it never inherits; w:3 copies m:2's own ids, which are empty.
    expect(ids).toEqual({ 'c:1': ['run_A'], 'm:2': [], 'w:3': [], 'k:4': ['run_own'] });
  });

  it('refreshes the recorded ids on later pause polls', async () => {
    const t = await setupPause([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    t.port.workersAt = (call) => (call < 2 ? [{ paneKey: 'a:1' }] : [{ paneKey: 'a:1', runId: 'run_late' }]);
    await t.run();
    expect((await t.readRun()).agents[0]?.orchestrationRunIds).toEqual(['run_late']);
  });
});

describe('the passes of listings', () => {
  const answer = (...answers: string[]) => ({ ask: answers, isTTY: false });

  it('recomputes roles from a new pass of all four listings after a "yes" on pause', async () => {
    const { err, port } = await runCli(['pause'], [{ paneKey: 'a:1', behavior: repliesWithToken() }], {
      ...answer('y'),
      newToken: () => TOKEN,
      configure: (p) => {
        p.coordinatorsAt = (call) => (call < 2 ? [] : ['a:1']);
      },
    });
    expect(err).toContain('(session)');
    expect(port.sends.map((s) => s.text)).toEqual([pauseMessage(TOKEN, 'coordinator')]);
    expect(port.listWorkersCalls).toBe(port.listRunsCalls);
    expect(port.listRunsCalls).toBeGreaterThanOrEqual(2);
  });

  it('recomputes roles from a new pass of all four listings after a late "yes" on an extended pause', async () => {
    // a:1 is unconfirmed and already messaged, so the first plan is empty; b:2 starts working at the third listing.
    const seed = async (store: ReturnType<typeof createRecordStore>) =>
      seedOpenRun(store, [agentRecord('a:1', { pauseStatus: 'unconfirmed', pauseReason: 'still-working', pauseBaseline: null, confirmedAt: null })]);
    const late = ({ listCalls }: { listCalls: number }) => (listCalls >= 3 ? { state: 'working', message: null } : { state: 'done', message: 'x' });
    const { err, port } = await runCli(['pause', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: working }, { paneKey: 'b:2', behavior: late }], {
      ...answer('y'),
      seed,
      newToken: () => TOKEN,
      configure: (p) => {
        // The late prompt comes after the third pass; the pass after its "yes" is the fourth.
        p.coordinatorsAt = (call) => (call >= 4 ? ['b:2'] : []);
      },
    });
    expect(err).toContain('repo/tree-b:2 (session)');
    expect(port.sends.map((s) => s.text)).toEqual([pauseMessage(TOKEN, 'coordinator')]);
  });

  it('takes one pass on resume with --yes, and a second one after a "yes"', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => seedOpenRun(store, [agentRecord('a:1')]);
    const withYes = await runCli(['resume', '--yes'], [{ paneKey: 'a:1', behavior: pausedDone() }], { seed });
    expect([withYes.port.listRunsCalls, withYes.port.listWorkersCalls]).toEqual([1, 1]);
    const asked = await runCli(['resume'], [{ paneKey: 'a:1', behavior: pausedDone() }], { seed, ask: ['y'] });
    expect([asked.port.listRunsCalls, asked.port.listWorkersCalls]).toEqual([2, 2]);
  });
});

describe('roles in resume', () => {
  const idle = (paneKey: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({ paneKey, behavior: pausedDone(), ...extra });

  async function setupResume(agents: FakeAgent[], records: AgentRecord[]) {
    const dir = await tempStateDir();
    await seedOpenRun(createRecordStore(dir), records);
    const port = new FakeOrca(agents);
    const go = () => resume({ port, clock: fakeClock(), store: createRecordStore(dir) });
    const readRun = async (): Promise<Run> => JSON.parse(await readFile(join(dir, 'run-1.json'), 'utf8')) as Run;
    return { port, go, readRun };
  }

  it('sends to sessions and workers in their order first, and to coordinators last', async () => {
    const { port, go } = await setupResume(
      [idle('c:1'), idle('s:2'), idle('w:3')],
      [agentRecord('c:1', { role: 'coordinator' }), agentRecord('s:2', { role: 'session' }), agentRecord('w:3')],
    );
    port.coordinatorsAt = () => ['c:1'];
    port.workersAt = () => [{ paneKey: 'w:3' }];
    await go();
    expect(port.sends).toEqual([
      { handle: 'term_s:2', text: continueMessage() },
      { handle: 'term_w:3', text: continueMessage() },
      { handle: 'term_c:1', text: continueMessage() },
    ]);
  });

  it('refreshes role and run ids of the pending agents it processes, and leaves resumed and gone entries as recorded', async () => {
    const { port, go, readRun } = await setupResume(
      [idle('p:1'), idle('r:2'), idle('g:3', { hasTerminal: false })],
      [
        agentRecord('p:1', { role: 'session', orchestrationRunIds: [] }),
        agentRecord('r:2', { role: 'session', orchestrationRunIds: ['old'], resumeStatus: 'resumed' }),
        agentRecord('g:3', { role: 'coordinator', orchestrationRunIds: ['kept'] }),
      ],
    );
    port.workersAt = () => [{ paneKey: 'p:1', runId: 'run_new' }, { paneKey: 'r:2', runId: 'run_new' }];
    await go();
    const [p, r, g] = (await readRun()).agents;
    expect(p).toMatchObject({ role: 'worker', orchestrationRunIds: ['run_new'] });
    expect(r).toMatchObject({ role: 'session', orchestrationRunIds: ['old'] });
    expect(g).toMatchObject({ resumeStatus: 'gone', role: 'coordinator', orchestrationRunIds: ['kept'] });
  });
});

describe('output of roles and run ids', () => {
  it('shows a run column with all ids joined by a comma and "run: unknown" when empty, then one count line that skips sessions', async () => {
    const { out, code } = await runCli(
      ['pause', '--yes'],
      [
        { paneKey: 'c:1', behavior: repliesWithToken() },
        { paneKey: 'w:2', behavior: repliesWithToken() },
        { paneKey: 's:3', behavior: repliesWithToken() },
      ],
      {
        configure: (p) => {
          p.runsAt = () => [runRow(p, 'run_a', 'c:1'), runRow(p, 'run_b', 'c:1')];
          p.workersAt = () => [{ paneKey: 'w:2' }];
        },
      },
    );
    expect(code).toBe(0);
    expect(out).toMatch(/tree-c:1\s+coordinator\s+run_a, run_b\s+confirmed/);
    expect(out).toMatch(/tree-w:2\s+worker\s+run: unknown\s+confirmed/);
    expect(out).toMatch(/tree-s:3\s+session\s+run: unknown\s+confirmed/);
    expect(out.endsWith('\n1 agents have a role but no known run\n')).toBe(true);
  });

  it('prints no count line when every coordinator and worker has a run', async () => {
    const { out } = await runCli(['pause', '--yes'], [{ paneKey: 'c:1', behavior: repliesWithToken() }], {
      configure: (p) => {
        p.coordinatorsAt = () => ['c:1'];
      },
    });
    expect(out).not.toContain('no known run');
  });

  it('counts the self block, and prints the line after "nothing to pause"', async () => {
    const { out } = await runCli(
      ['pause', '--yes'],
      [
        { paneKey: 's:1', behavior: working },
        { paneKey: 'w:1', parentPaneKey: 's:1', behavior: pausedDone() },
      ],
      { env: { ORCA_PANE_KEY: 's:1' } },
    );
    expect(out.startsWith('nothing to pause\n')).toBe(true);
    expect(out).toMatch(/tree-s:1\s+coordinator\s+run: unknown\s+self/);
    expect(out.endsWith('\n1 agents have a role but no known run\n')).toBe(true);
  });

  it('shows the run column and the count line in the close table', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) =>
      seedOpenRun(store, [agentRecord('w:1', { orchestrationRunIds: ['run_x'], pauseStatus: 'unconfirmed' }), agentRecord('c:2', { role: 'coordinator', pauseStatus: 'unconfirmed' })]);
    const { out, port } = await runCli(['close'], [], { seed });
    expect(out).toMatch(/tree-w:1\s+worker\s+run_x\s+unconfirmed/);
    expect(out).toMatch(/tree-c:2\s+coordinator\s+run: unknown\s+unconfirmed/);
    expect(out.endsWith('\n1 agents have a role but no known run\n')).toBe(true);
    expect(port.listRunsCalls).toBe(0);
  });

  it('keeps a plain handoff child with a null parent link a session, so its run is never guessed', async () => {
    const { out } = await runCli(['pause', '--yes'], [{ paneKey: 'p:1', behavior: pausedDone() }, { paneKey: 'k:1', parentPaneKey: null, behavior: repliesWithToken() }]);
    expect(out).not.toContain('coordinator');
    expect(out).toMatch(/tree-k:1\s+session\s+run: unknown/);
  });

  it('keeps the count line out of --json and carries the run ids in each agent entry', async () => {
    const { out } = await runCli(['pause', '--yes', '--json'], [{ paneKey: 'c:1', behavior: repliesWithToken() }], {
      configure: (p) => {
        p.runsAt = () => [runRow(p, 'run_a', 'c:1')];
      },
    });
    expect(out).not.toContain('no known run');
    expect(JSON.parse(out).run.agents[0]).toMatchObject({ role: 'coordinator', orchestrationRunIds: ['run_a'] });
  });

  it('prints the count line after the resume table, not after an error', async () => {
    const seed = async (store: ReturnType<typeof createRecordStore>) => seedOpenRun(store, [agentRecord('a:1', { role: 'worker' })]);
    const ok = await runCli(['resume', '--yes'], [{ paneKey: 'a:1', behavior: pausedDone() }], { seed, configure: (p) => { p.workersAt = () => [{ paneKey: 'a:1' }]; } });
    expect(ok.out.endsWith('\n1 agents have a role but no known run\n')).toBe(true);
    const failed = await runCli(['resume', '--yes'], [{ paneKey: 'a:1', behavior: pausedDone() }], { seed, configure: (p) => { p.failWorkerListsFrom = 1; } });
    expect(failed.code).toBe(2);
    expect(failed.out).toBe('');
  });
});
