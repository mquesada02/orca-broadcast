import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { continueMessage, resume } from '../src/resume.js';
import { createRecordStore } from '../src/store.js';
import type { AgentRecord, ResumeProgress, Run } from '../src/types.js';
import { type FakeAgent, fakeClock, FakeOrca, PAUSED_REPLY, pausedDone, seedOpenRun, startsNewTurnAfterContinue, tempStateDir, working } from './helpers/fake-orca.js';

function agentRecord(paneKey: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    paneKey,
    worktreeId: `wt-${paneKey}`,
    worktree: `tree-${paneKey}`,
    repo: 'repo',
    role: 'worker',
    lastHandle: null,
    pauseStatus: 'confirmed',
    pauseReason: null,
    pauseBaseline: PAUSED_REPLY,
    messagePending: false,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    wakeCount: 0,
    resumeStatus: 'pending',
    ...extra,
  };
}

async function setup(agents: FakeAgent[], records: AgentRecord[] = agents.map((a) => agentRecord(a.paneKey))) {
  const dir = await tempStateDir();
  const store = createRecordStore(dir);
  const run: Run = { runId: 'run-1', token: 'abcd1234', startedAt: '2026-01-01T00:00:00.000Z', status: 'open', agents: records };
  await store.save(run);
  await store.setCurrent(run.runId);
  const port = new FakeOrca(agents);
  const clock = fakeClock();
  const progress: ResumeProgress[] = [];
  const go = (signal?: AbortSignal) => resume({ port, clock, store: createRecordStore(dir), onProgress: (p) => progress.push(p), signal });
  const readRun = async (): Promise<Run> => JSON.parse(await readFile(join(dir, 'run-1.json'), 'utf8')) as Run;
  return { dir, port, clock, go, readRun, progress };
}

describe('resume happy path', () => {
  it('marks a done agent resumed when it starts a new turn after CONTINUE, closes the run and exits 0', async () => {
    const { dir, port, go, readRun } = await setup([{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }]);

    const summary = await go();

    expect(summary.exitCode).toBe(0);
    expect(summary.outcome).toBe('done');
    expect(port.sends).toEqual([{ handle: 'term_a:1', text: continueMessage() }]);
    const run = await readRun();
    expect(run.status).toBe('closed');
    expect(run.agents[0]).toMatchObject({ resumeStatus: 'resumed' });
    expect(run.agents[0]?.resumeReason).toBeUndefined();
    expect(await readdir(dir)).not.toContain('current');
  });

  it('sends the exact one-line continue message', async () => {
    const { port, go } = await setup([{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }]);
    await go();
    expect(port.sends[0]?.text).toBe(
      '[orca-broadcast] CONTINUE. The user asked you to continue. Continue your task from the note in your last pause reply.',
    );
    expect(port.sends[0]?.text).not.toContain('\n');
  });

  it('keeps a done agent pending with no-proof when it does not move, and exits 1', async () => {
    const { dir, go, readRun } = await setup([{ paneKey: 'a:1', behavior: pausedDone(PAUSED_REPLY) }]);

    const summary = await go();

    expect(summary.exitCode).toBe(1);
    const run = await readRun();
    expect(run.status).toBe('open');
    expect(run.agents[0]).toMatchObject({ resumeStatus: 'pending', resumeReason: 'no-proof' });
    expect(await readdir(dir)).toContain('current');
  });

  it('stores continueBaseline before the send and continueSentAt after an accepted send', async () => {
    const { port, go, readRun, dir } = await setup([{ paneKey: 'a:1', stateStartedAt: 7, behavior: pausedDone(PAUSED_REPLY) }]);
    let during: Run | undefined;
    port.onSend = async () => {
      during = JSON.parse(await readFile(join(dir, 'run-1.json'), 'utf8')) as Run;
    };

    await go();

    expect(during?.agents[0]?.continueBaseline).toEqual({ stateStartedAt: 7, lastAssistantMessage: PAUSED_REPLY });
    expect(during?.agents[0]?.continueSentAt).toBeUndefined();
    expect((await readRun()).agents[0]?.continueSentAt).toBe(new Date(1_000_000).toISOString());
  });

  it('counts a change that shows in the poll at 58 s or 60 s, but never sees one after 60 s', async () => {
    const changeAtPoll = (n: number) => (ctx: { listCalls: number; received: string[] }) =>
      ctx.listCalls > n && ctx.received.length ? { state: 'done', message: 'new turn' } : { state: 'done', message: PAUSED_REPLY };
    // listCalls 1 is the initial listing; poll k (k * 2 s after the send) is listCall k + 1.
    const at58 = await setup([{ paneKey: 'a:1', behavior: changeAtPoll(29) }]);
    expect((await at58.go()).exitCode).toBe(0);
    const at60 = await setup([{ paneKey: 'a:1', behavior: changeAtPoll(30) }]);
    expect((await at60.go()).exitCode).toBe(0);
    const late = await setup([{ paneKey: 'a:1', behavior: changeAtPoll(31) }]);
    const summary = await late.go();
    expect(summary.exitCode).toBe(1);
    expect(summary.rows[0]).toMatchObject({ resumeStatus: 'pending', resumeReason: 'no-proof' });
    expect(late.clock.slept).toBe(60_000);
  });

  it('measures each agent window from its own send', async () => {
    const changeAtPoll = (n: number) => (ctx: { listCalls: number; received: string[] }) =>
      ctx.listCalls > n && ctx.received.length ? { state: 'done', message: 'new turn' } : { state: 'done', message: PAUSED_REPLY };
    const { port, clock, go } = await setup([
      { paneKey: 'a:1', behavior: changeAtPoll(30) },
      { paneKey: 'b:2', behavior: changeAtPoll(30) },
    ]);
    let sends = 0;
    port.onSend = () => {
      sends += 1;
      if (sends === 2) clock.slept += 10_000;
    };

    const summary = await go();

    // b:2 sent at +10 s; a:1's window closed at 60 s, b:2's at 70 s. The change is first seen at poll 30 (60 s after the last send).
    expect(summary.rows.map((r) => r.resumeStatus)).toEqual(['pending', 'resumed']);
    expect(summary.rows[0]?.resumeReason).toBe('no-proof');
  });
});

describe('earlier send and re-run', () => {
  it('marks an agent resumed without a new send when it moved since the stored baseline', async () => {
    const { port, go } = await setup(
      [{ paneKey: 'a:1', behavior: () => ({ state: 'working', message: 'moved on' }) }],
      [agentRecord('a:1', { continueBaseline: { stateStartedAt: 1, lastAssistantMessage: PAUSED_REPLY }, continueSentAt: '2026-01-01T00:01:00.000Z' })],
    );

    const summary = await go();

    expect(port.sends).toHaveLength(0);
    expect(summary.rows[0]?.resumeStatus).toBe('resumed');
    expect(summary.exitCode).toBe(0);
  });

  it('marks a waiting agent resumed without a send when it moved since the stored baseline', async () => {
    const { port, go } = await setup(
      [{ paneKey: 'a:1', behavior: () => ({ state: 'waiting', message: 'moved on' }) }],
      [agentRecord('a:1', { continueBaseline: { stateStartedAt: 1, lastAssistantMessage: PAUSED_REPLY }, continueSentAt: '2026-01-01T00:01:00.000Z' })],
    );
    const summary = await go();
    expect(port.sends).toHaveLength(0);
    expect(summary.rows[0]?.resumeStatus).toBe('resumed');
  });

  it('sends again with a fresh baseline to an agent that did not move, and resends nothing to resumed or gone agents', async () => {
    const { port, go, readRun } = await setup(
      [
        { paneKey: 'a:1', behavior: pausedDone(PAUSED_REPLY) },
        { paneKey: 'b:2', behavior: working },
        { paneKey: 'c:3', behavior: working, hasTerminal: false },
      ],
      [
        agentRecord('a:1', { continueBaseline: { stateStartedAt: 1, lastAssistantMessage: PAUSED_REPLY }, continueSentAt: '2026-01-01T00:01:00.000Z' }),
        agentRecord('b:2', { resumeStatus: 'resumed' }),
        agentRecord('c:3', { resumeStatus: 'gone', resumeReason: 'terminal-closed' }),
      ],
    );

    await go();

    expect(port.sends.map((s) => s.handle)).toEqual(['term_a:1']);
    expect((await readRun()).agents[0]?.continueSentAt).toBe(new Date(1_000_000).toISOString());
  });

  it('retries only pending agents on a second resume', async () => {
    const { port, go } = await setup([
      { paneKey: 'a:1', behavior: startsNewTurnAfterContinue },
      { paneKey: 'b:2', behavior: pausedDone(PAUSED_REPLY) },
    ]);
    await go();
    expect(port.sends).toHaveLength(2);

    const second = await go();

    expect(port.sends.map((s) => s.handle)).toEqual(['term_a:1', 'term_b:2', 'term_b:2']);
    expect(second.rows.map((r) => r.resumeStatus)).toEqual(['resumed', 'pending']);
  });
});

describe('state check and Locate', () => {
  it.each(['waiting', 'blocked'])('sends nothing to a %s agent and keeps it pending with waiting-permission', async (state) => {
    const { port, go } = await setup([{ paneKey: 'a:1', behavior: () => ({ state, message: PAUSED_REPLY }) }]);
    const summary = await go();
    expect(port.sends).toHaveLength(0);
    expect(summary.rows[0]).toMatchObject({ resumeStatus: 'pending', resumeReason: 'waiting-permission' });
    expect(summary.exitCode).toBe(1);
  });

  it.each([
    ['agent-exited', { agentIdentity: 'zsh' }],
    ['agent-exited', { agentIdentity: null }],
    ['terminal-closed', { hasTerminal: false }],
    ['terminal-orphaned', { orphaned: true }],
    ['agent-missing', { hasRow: false }],
  ] as const)('marks the agent gone (%s) and sends nothing', async (reason, extra: Partial<FakeAgent>) => {
    const { port, go } = await setup([{ paneKey: 'a:1', behavior: pausedDone(), ...extra }]);
    const summary = await go();
    expect(port.sends).toHaveLength(0);
    expect(summary.rows[0]).toMatchObject({ resumeStatus: 'gone', resumeReason: reason });
    expect(summary.exitCode).toBe(0);
    expect(summary.run?.status).toBe('closed');
  });

  it('closes the run with exit 0 when agents are only resumed or gone, and keeps it open with one pending', async () => {
    const mixed = await setup([
      { paneKey: 'a:1', behavior: startsNewTurnAfterContinue },
      { paneKey: 'b:2', behavior: pausedDone(), agentIdentity: 'zsh' },
    ]);
    expect((await mixed.go()).exitCode).toBe(0);
    expect((await mixed.readRun()).status).toBe('closed');

    const open = await setup([
      { paneKey: 'a:1', behavior: startsNewTurnAfterContinue },
      { paneKey: 'b:2', behavior: () => ({ state: 'waiting', message: PAUSED_REPLY }) },
    ]);
    expect((await open.go()).exitCode).toBe(1);
    expect((await open.readRun()).status).toBe('open');
  });
});

describe('working agents and failed sends', () => {
  it('marks a working agent resumed (queued-while-working) at once, with one send and no polling', async () => {
    const { port, clock, go } = await setup([{ paneKey: 'a:1', behavior: working }]);
    const summary = await go();
    expect(port.sendsTo('a:1')).toBe(1);
    expect(port.listCalls).toBe(1);
    expect(clock.slept).toBe(0);
    expect(summary.rows[0]).toMatchObject({ resumeStatus: 'resumed', resumeReason: 'queued-while-working' });
    expect(summary.exitCode).toBe(0);
  });

  it.each([
    ['not accepted', (p: FakeOrca) => (p.sendResult = () => ({ accepted: false, reason: 'terminal_handle_stale' }))],
    ['thrown', (p: FakeOrca) => (p.onSend = () => Promise.reject(new Error('boom')))],
  ])('keeps the agent pending with send-failed when the send is %s, and retries it on the next resume', async (_name, fail) => {
    const { port, go } = await setup([{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }]);
    fail(port);
    const first = await go();
    expect(first.rows[0]).toMatchObject({ resumeStatus: 'pending', resumeReason: 'send-failed' });
    expect(first.exitCode).toBe(1);

    port.sendResult = () => ({ accepted: true });
    port.onSend = () => {};
    const second = await go();
    expect(second.rows[0]?.resumeStatus).toBe('resumed');
    expect(second.exitCode).toBe(0);
  });
});

describe('no run and errors', () => {
  it('reports nothing to resume with exit 0 and no Orca call when no run is open', async () => {
    const dir = await tempStateDir();
    const port = new FakeOrca([{ paneKey: 'a:1', behavior: working }]);
    const summary = await resume({ port, clock: fakeClock(), store: createRecordStore(dir) });
    expect(summary).toMatchObject({ outcome: 'nothing-to-do', exitCode: 0, run: null });
    expect(port.listCalls).toBe(0);
  });

  it('exits 2 on a listing error and leaves the record unchanged', async () => {
    const { port, go, readRun } = await setup([{ paneKey: 'a:1', behavior: working }]);
    const before = await readRun();
    port.listError = new Error('orca-ide not found');
    const summary = await go();
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2, error: 'orca-ide not found' });
    expect(await readRun()).toEqual(before);
  });

  it('exits 2 when the run file cannot be parsed', async () => {
    const { dir, go, port } = await setup([{ paneKey: 'a:1', behavior: working }]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'run-1.json'), '{not json');
    const summary = await go();
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2 });
    expect(port.sends).toHaveLength(0);
  });
});

describe('progress', () => {
  it('reports resumed over non-gone agents after the sends and after each poll', async () => {
    const { go, progress } = await setup(
      [
        { paneKey: 'a:1', behavior: startsNewTurnAfterContinue },
        { paneKey: 'b:2', behavior: pausedDone(), agentIdentity: 'zsh' },
      ],
    );
    await go();
    expect(progress[0]).toEqual({ resumed: 0, total: 1 });
    expect(progress.at(-1)).toEqual({ resumed: 1, total: 1 });
  });
});

describe('safety rails', () => {
  it('on a signal while waiting for proof saves the record and exits 130, and the re-run resumes from it without a new send', async () => {
    const { clock, port, go, readRun, dir } = await setup([{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }]);
    const abort = new AbortController();
    clock.onSleep = () => abort.abort('SIGTERM');

    const interrupted = await go(abort.signal);

    expect(interrupted).toMatchObject({ outcome: 'error', exitCode: 130, error: 'interrupted by SIGTERM' });
    const saved = await readRun();
    expect(saved.status).toBe('open');
    expect(saved.agents[0]).toMatchObject({ resumeStatus: 'pending' });
    expect(saved.agents[0]?.continueSentAt).toBeDefined();
    expect(saved.agents[0]?.continueBaseline).toBeDefined();
    expect(await readdir(dir)).toContain('current');

    clock.onSleep = () => {};
    const rerun = await go();

    expect(rerun.exitCode).toBe(0);
    expect(port.sends).toHaveLength(1);
    expect((await readRun()).status).toBe('closed');
  });

  it('lets a send in flight finish and be recorded, then stops before the next send', async () => {
    const { port, go, readRun } = await setup([
      { paneKey: 'a:1', behavior: startsNewTurnAfterContinue },
      { paneKey: 'b:2', behavior: startsNewTurnAfterContinue },
    ]);
    const abort = new AbortController();
    port.onSend = () => abort.abort('SIGHUP');

    const summary = await go(abort.signal);

    expect(summary.exitCode).toBe(130);
    expect(port.sends).toHaveLength(1);
    const [first, second] = (await readRun()).agents;
    expect(first?.continueSentAt).toBeDefined();
    expect(second).toMatchObject({ resumeStatus: 'pending' });
    expect(second?.continueSentAt).toBeUndefined();
  });

  it('exits 130 without calling Orca when already interrupted', async () => {
    const { port, go } = await setup([{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }]);
    const summary = await go(AbortSignal.abort('SIGINT'));
    expect(summary.exitCode).toBe(130);
    expect(port.listCalls).toBe(0);
    expect(port.sends).toHaveLength(0);
  });

  it('retries a failing list 3 times, 1 second apart, before exiting 2', async () => {
    const { clock, port, go } = await setup([{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }]);
    port.listFailures = 2;
    expect((await go()).exitCode).toBe(0);
    expect(clock.slept).toBeGreaterThanOrEqual(2000);

    const failing = await setup([{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }]);
    failing.port.listError = new Error('orca-ide worktree ps failed: down');
    expect(await failing.go()).toMatchObject({ exitCode: 2 });
    expect(failing.clock.slept).toBe(2000);
    expect(failing.port.sends).toHaveLength(0);
  });
});

describe('resume reasons', () => {
  const cases: [Run['reason'], string][] = [
    ['network', 'The network is back.'],
    ['away', 'The user is back.'],
    ['end-of-day', 'The user is back for a new session.'],
    ['limit', 'The limit has reset.'],
    [undefined, 'The user asked you to continue.'],
  ];

  for (const [reason, sentence] of cases) {
    it(`sends the ${reason ?? 'neutral (no stored reason)'} continue sentence`, async () => {
      const dir = await tempStateDir();
      await seedOpenRun(createRecordStore(dir), [agentRecord('a:1')], reason ? { reason } : {});
      const port = new FakeOrca([{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }]);

      await resume({ port, clock: fakeClock(), store: createRecordStore(dir) });

      expect(port.sends.map((s) => s.text)).toEqual([`[orca-broadcast] CONTINUE. ${sentence} Continue your task from the note in your last pause reply.`]);
    });
  }
});
