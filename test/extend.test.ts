import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { pause, pauseMessage } from '../src/pause.js';
import { continueMessage, resume } from '../src/resume.js';
import { createRecordStore } from '../src/store.js';
import type { Preset } from '../src/reasons.js';
import type { Confirm, Run } from '../src/types.js';
import {
  agentRecord,
  type Behavior,
  CONTINUE_PREFIX,
  doneWithToken,
  type FakeAgent,
  fakeClock,
  FakeOrca,
  repliesWithToken,
  seedOpenRun,
  tempStateDir,
  working,
  wokenWorking,
} from './helpers/fake-orca.js';

const TIMEOUT = 60_000;
const TOKEN = 'abcd1234';
const OLD_REPLY = `Stopped.\nORCA-PAUSED ${TOKEN}`;
const SELF_HEADING = 'self (not paused) — this session must stop by itself';

async function setup(agents: FakeAgent[]) {
  const dir = await tempStateDir();
  const port = new FakeOrca(agents);
  const clock = fakeClock();
  const store = () => createRecordStore(dir);
  const runPause = (selfPaneKey?: string, timeoutMs = TIMEOUT) =>
    pause(timeoutMs, { port, clock, store: store(), newToken: () => TOKEN, selfPaneKey });
  const runResume = () => resume({ port, clock, store: store() });
  const readRun = async (runId = 'run-1'): Promise<Run> => JSON.parse(await readFile(join(dir, 'pauses', `${runId}.json`), 'utf8')) as Run;
  return { dir, port, clock, store, runPause, runResume, readRun };
}

/** Working until messaged; after a pause message it ends with the token, after CONTINUE it is working again. */
const cycleAgent: Behavior = ({ received }) => {
  const last = received.at(-1);
  if (last === undefined || last.startsWith(CONTINUE_PREFIX)) return { state: 'working', message: null };
  return doneWithToken(received, 'Stopped.');
};

/** Confirms after each pause message, then runs a new turn two listings later (a wake). */
const wakesAfterConfirm = (): Behavior => {
  let calls = 0;
  let lastLen = 0;
  return ({ received }) => {
    if (received.length === 0) return { state: 'working', message: null };
    if (received.length !== lastLen) {
      lastLen = received.length;
      calls = 0;
    }
    calls += 1;
    if (calls <= 2) return doneWithToken(received, `note ${received.length}`);
    return { state: 'done', message: `extra turn ${received.length}-${calls}` };
  };
};

/** An agent that a background task has woken since the run confirmed it: working, with a newer reply and no token line. */
const wokenAgent: Behavior = (ctx) => (ctx.received.length === 0 ? wokenWorking(ctx) : cycleAgent(ctx));

const confirmedRecord = (paneKey: string) => agentRecord(paneKey, { pauseBaseline: OLD_REPLY });

describe('extending an open run', () => {
  it('keeps the run and its token, skips confirmed agents and does not message unconfirmed ones again', async () => {
    const t = await setup([
      { paneKey: 'a:1', behavior: () => ({ state: 'done', message: OLD_REPLY }) },
      { paneKey: 'b:2', behavior: () => ({ state: 'done', message: 'no token here' }) },
    ]);
    await seedOpenRun(t.store(), [
      confirmedRecord('a:1'),
      agentRecord('b:2', { pauseStatus: 'unconfirmed', pauseReason: 'done-no-token', pauseBaseline: 'no token here', confirmedAt: null }),
    ]);

    const summary = await t.runPause(undefined, 5000);

    expect(t.port.sends).toHaveLength(0);
    expect(summary.run).toMatchObject({ runId: 'run-1', token: TOKEN, startedAt: '2026-01-01T00:00:00.000Z' });
    expect(summary.rows.map((r) => [r.paneKey, r.pauseStatus, r.pauseReason])).toEqual([
      ['a:1', 'confirmed', null],
      ['b:2', 'unconfirmed', 'done-no-token'],
    ]);
    expect(summary.exitCode).toBe(1);
  });

  it('extends an open run that only the newest status: open file reveals', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: () => ({ state: 'done', message: OLD_REPLY }) }]);
    await mkdir(join(t.dir, 'pauses'), { recursive: true });
    const run: Run = { runId: 'run-1', token: TOKEN, startedAt: '2026-01-01T00:00:00.000Z', status: 'open', agents: [confirmedRecord('a:1')] };
    await writeFile(join(t.dir, 'pauses', 'run-1.json'), JSON.stringify(run));

    const summary = await t.runPause();

    expect(summary).toMatchObject({ outcome: 'done', exitCode: 0 });
    expect(summary.run?.runId).toBe('run-1');
  });

  it('gives a send-failed agent one more pause message and confirms it', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await seedOpenRun(t.store(), [
      agentRecord('a:1', { pauseStatus: 'unconfirmed', pauseReason: 'send-failed', messagePending: true, confirmedAt: null }),
    ]);

    const summary = await t.runPause();

    expect(t.port.sendsTo('a:1')).toBe(1);
    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'confirmed', pauseReason: null, messagePending: false });
  });

  it('gives a re-woken agent one more pause message and resets its wake counter', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await seedOpenRun(t.store(), [
      agentRecord('a:1', { pauseStatus: 'unconfirmed', pauseReason: 're-woken', wakeCount: 2, confirmedAt: null }),
      agentRecord('gone:9', { wakeCount: 1, resumeStatus: 'gone', resumeReason: 'terminal-closed' }),
    ]);

    const summary = await t.runPause();

    expect(t.port.sendsTo('a:1')).toBe(1);
    expect(summary.rows.find((r) => r.paneKey === 'a:1')).toMatchObject({ pauseStatus: 'confirmed', wakeCount: 0 });
    expect(summary.rows.find((r) => r.paneKey === 'gone:9')).toMatchObject({ wakeCount: 1, resumeStatus: 'gone', resumeReason: 'terminal-closed' });
  });

  it('pauses a resumed agent again and resets its resume state', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: cycleAgent }]);
    await seedOpenRun(t.store(), [
      agentRecord('a:1', {
        pauseBaseline: OLD_REPLY,
        resumeStatus: 'resumed',
        resumeReason: 'queued-while-working',
        continueSentAt: '2026-01-01T00:01:00.000Z',
        continueBaseline: { stateStartedAt: 1, lastAssistantMessage: OLD_REPLY },
      }),
    ]);

    const summary = await t.runPause();

    expect(t.port.sendsTo('a:1')).toBe(1);
    const [agent] = (await t.readRun()).agents;
    expect(agent).toMatchObject({ pauseStatus: 'confirmed', resumeStatus: 'pending', messagePending: false });
    expect(agent).not.toHaveProperty('resumeReason');
    expect(agent).not.toHaveProperty('continueSentAt');
    expect(agent).not.toHaveProperty('continueBaseline');
    expect(summary.exitCode).toBe(0);
  });

  it('does not confirm a resumed agent from its old token reply', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: () => ({ state: 'done', message: OLD_REPLY }) }]);
    await seedOpenRun(t.store(), [agentRecord('a:1', { pauseBaseline: OLD_REPLY, resumeStatus: 'resumed', resumeReason: 'queued-while-working' })]);

    const summary = await t.runPause(undefined, 5000);

    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'done-no-token', resumeStatus: 'pending' });
    expect(summary.exitCode).toBe(1);
  });

  it('keeps a gone unconfirmed agent in the exit code of a re-run', async () => {
    const t = await setup([]);
    await seedOpenRun(t.store(), [
      agentRecord('g:1', { pauseStatus: 'unconfirmed', pauseReason: 'still-working', confirmedAt: null, resumeStatus: 'gone', resumeReason: 'terminal-closed' }),
    ]);

    const summary = await t.runPause();

    expect(summary).toMatchObject({ outcome: 'done', exitCode: 1 });
    expect(t.port.sends).toHaveLength(0);
  });

  it('clears a stale continue proof when it re-pauses, so resume sends a fresh CONTINUE', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: wokenAgent }]);
    await seedOpenRun(t.store(), [
      agentRecord('a:1', {
        pauseBaseline: OLD_REPLY,
        resumeReason: 'no-proof',
        continueSentAt: '2026-01-01T00:01:00.000Z',
        continueBaseline: { stateStartedAt: 1, lastAssistantMessage: 'something older' },
      }),
    ]);

    await t.runPause(); // the agent has a newer reply without the token, so the wake check re-pauses it and clears the proof
    const [paused] = (await t.readRun()).agents;
    expect(paused).toMatchObject({ pauseStatus: 'confirmed', wakeCount: 1 });
    expect(paused).not.toHaveProperty('continueSentAt');
    expect(paused).not.toHaveProperty('continueBaseline');

    await t.runResume();

    expect(t.port.sends.filter((s) => s.text === continueMessage())).toHaveLength(1);
  });

  it('marks a normal agent woken twice as re-woken, and a re-run sends it one more pause message', async () => {
    const t = await setup([
      { paneKey: 'a:1', behavior: wakesAfterConfirm() },
      { paneKey: 'b:2', behavior: working }, // keeps the wait loop running so that a:1 wakes
    ]);

    const first = await t.runPause();
    expect(first.rows[0]).toMatchObject({ pauseReason: 're-woken', wakeCount: 2 });
    expect(t.port.sendsTo('a:1')).toBe(2);

    const second = await t.runPause();

    expect(second.run?.runId).toBe(first.run?.runId);
    expect(t.port.sendsTo('a:1')).toBe(4); // one for the re-run reset, then the first wake of this invocation
    expect(second.rows[0]).toMatchObject({ pauseReason: 're-woken', wakeCount: 2 });
  });

  it('anchors the timeout at the start of the invocation, not at the run startedAt', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: working }]);
    await seedOpenRun(t.store(), [agentRecord('a:1', { pauseStatus: 'unconfirmed', pauseReason: 'still-working', confirmedAt: null, messagePending: true })]);

    await t.runPause(undefined, 5000);

    expect(t.port.listCalls).toBe(4); // polls at 0s, 2s and 4s, plus one pre-send read
    expect(t.clock.slept).toBe(6000);
  });

  it('runs at least one full poll before the exit condition, even with a tiny timeout', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await seedOpenRun(t.store(), [agentRecord('a:1', { pauseStatus: 'unconfirmed', pauseReason: 'send-failed', messagePending: true, confirmedAt: null })]);

    await t.runPause(undefined, 1);

    expect(t.port.sendsTo('a:1')).toBe(1);
  });

  it('completes a pause → resume (partial) → pause → resume cycle, reaching every agent once per cycle', async () => {
    const t = await setup([
      { paneKey: 'a:1', behavior: cycleAgent },
      { paneKey: 'b:2', behavior: cycleAgent },
    ]);
    const continueSends = (key: string) => t.port.sends.filter((s) => s.handle === t.port.handleOf(key) && s.text === continueMessage()).length;
    let rejected = 0;
    const continues = (key: string) => continueSends(key) - (key === 'b:2' ? rejected : 0); // accepted CONTINUE messages

    expect((await t.runPause()).exitCode).toBe(0);
    t.port.sendResult = (handle) => {
      if (handle !== t.port.handleOf('b:2')) return { accepted: true };
      rejected += 1;
      return { accepted: false, reason: 'terminal_handle_stale' };
    };
    expect((await t.runResume()).exitCode).toBe(1);
    expect([continues('a:1'), continues('b:2')]).toEqual([1, 0]);

    t.port.sendResult = () => ({ accepted: true });
    const second = await t.runPause();
    expect(second.exitCode).toBe(0);
    expect(second.run?.token).toBe(TOKEN);
    expect(t.port.sendsTo('a:1') - continueSends('a:1')).toBe(2); // paused once per cycle
    expect(t.port.sendsTo('b:2') - continueSends('b:2')).toBe(1); // confirmed agent skipped on extend

    const last = await t.runResume();
    expect(last.exitCode).toBe(0);
    expect([continues('a:1'), continues('b:2')]).toEqual([2, 1]);
    expect((await t.readRun(last.run?.runId)).status).toBe('closed');
  });
});

describe('self handling in pause', () => {
  it('records self as pending/self, sends it nothing, and a later resume sends it CONTINUE', async () => {
    const t = await setup([
      { paneKey: 's:1', behavior: working },
      { paneKey: 'a:1', behavior: cycleAgent },
    ]);

    const summary = await t.runPause('s:1');

    expect(t.port.sendsTo('s:1')).toBe(0);
    expect(summary.exitCode).toBe(0);
    expect(summary.rows.map((r) => r.paneKey)).toEqual(['a:1']);
    expect(summary.self).toMatchObject({
      paneKey: 's:1',
      pauseStatus: 'unconfirmed',
      pauseReason: 'self',
      messagePending: false,
      wakeCount: 0,
      resumeStatus: 'pending',
    });
    expect((await t.readRun(summary.run?.runId)).agents.map((a) => a.paneKey)).toEqual(['a:1', 's:1']);

    const resumed = await t.runResume();

    expect(resumed.exitCode).toBe(0);
    expect(t.port.sends.filter((s) => s.handle === t.port.handleOf('s:1')).map((s) => s.text)).toEqual([continueMessage()]);
    expect(resumed.rows.find((r) => r.paneKey === 's:1')).toMatchObject({ resumeStatus: 'resumed', resumeReason: 'queued-while-working' });
  });

  it('pauses from A, then from B: A gets a pause message and B is recorded as self', async () => {
    let bIsWorking = false;
    const t = await setup([
      { paneKey: 's:1', behavior: repliesWithToken() },
      { paneKey: 'b:9', behavior: () => (bIsWorking ? { state: 'working', message: null } : { state: 'done', message: 'idle' }) },
      { paneKey: 'a:1', behavior: repliesWithToken() },
    ]);
    await t.runPause('s:1');
    expect(t.port.sendsTo('s:1')).toBe(0);
    bIsWorking = true;

    const second = await t.runPause('b:9');

    expect(t.port.sendsTo('s:1')).toBe(1);
    expect(t.port.sendsTo('b:9')).toBe(0);
    expect(second.self).toMatchObject({ paneKey: 'b:9', pauseReason: 'self' });
    expect(second.rows.find((r) => r.paneKey === 's:1')).toMatchObject({ pauseStatus: 'confirmed', pauseReason: null });
    expect(second.exitCode).toBe(0);
  });

  it('still hands over an earlier self when pause runs with no self pane key', async () => {
    const t = await setup([
      { paneKey: 's:1', behavior: repliesWithToken() },
      { paneKey: 'a:1', behavior: repliesWithToken() },
    ]);
    await t.runPause('s:1');

    const second = await t.runPause();

    expect(t.port.sendsTo('s:1')).toBe(1);
    expect(second.self).toBeNull();
    expect(second.rows.find((r) => r.paneKey === 's:1')).toMatchObject({ pauseStatus: 'confirmed' });
  });

  it('overwrites an earlier record of self, whatever it was', async () => {
    const t = await setup([
      { paneKey: 's:1', behavior: working },
      { paneKey: 'a:1', behavior: repliesWithToken() },
    ]);
    await seedOpenRun(t.store(), [
      agentRecord('s:1', {
        pauseBaseline: OLD_REPLY,
        resumeStatus: 'resumed',
        resumeReason: 'queued-while-working',
        continueSentAt: '2026-01-01T00:01:00.000Z',
        continueBaseline: { stateStartedAt: 1, lastAssistantMessage: OLD_REPLY },
        wakeCount: 1,
      }),
      agentRecord('a:1'),
    ]);

    const summary = await t.runPause('s:1');

    expect(t.port.sendsTo('s:1')).toBe(0);
    expect(summary.self).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'self', resumeStatus: 'pending', wakeCount: 0, confirmedAt: null });
    expect(summary.self).not.toHaveProperty('resumeReason');
    expect(summary.self).not.toHaveProperty('continueSentAt');
    expect(summary.self).not.toHaveProperty('continueBaseline');
  });

  it('does not record a self that is not a Claude agent, and it does not change the exit code', async () => {
    const t = await setup([
      { paneKey: 's:1', behavior: working, agentIdentity: 'codex' },
      { paneKey: 'a:1', behavior: repliesWithToken() },
    ]);

    const summary = await t.runPause('s:1');

    expect(summary.self).toBeNull();
    expect(summary.rows.map((r) => r.paneKey)).toEqual(['a:1']);
    expect(summary.exitCode).toBe(0);
  });

  it('returns a null self on the error outcome', async () => {
    const t = await setup([{ paneKey: 's:1', behavior: working }]);
    t.port.listError = new Error('orca-ide worktree ps failed: boom');

    const summary = await t.runPause('s:1');

    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2, self: null });
  });
});

describe('self handling in the CLI', () => {
  async function runCli(env: NodeJS.ProcessEnv, agents: FakeAgent[]) {
    const dir = await tempStateDir();
    const out: string[] = [];
    const err: string[] = [];
    const port = new FakeOrca(agents);
    const code = await main(['pause', '--yes'], { XDG_STATE_HOME: dir, ...env }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: false }, { port, clock: fakeClock() });
    return { code, out: out.join(''), err: err.join(''), port };
  }

  const selfBlock = `${SELF_HEADING}\n  repo  worktree  role    status  reason\n  repo  tree-s:1  worker  self    -\n\n`;

  it('prints the self block after "nothing to pause" when self is the only working Claude agent', async () => {
    const { code, out, port } = await runCli({ ORCA_PANE_KEY: 's:1' }, [{ paneKey: 's:1', behavior: working }]);
    expect(code).toBe(0);
    expect(out).toBe(`nothing to pause\n${selfBlock}`);
    expect(port.sends).toHaveLength(0);
  });

  it('prints only "nothing to pause" when self is not working', async () => {
    const { out } = await runCli({ ORCA_PANE_KEY: 's:1' }, [{ paneKey: 's:1', behavior: () => ({ state: 'done', message: 'x' }) }]);
    expect(out).toBe('nothing to pause\n');
  });

  it('treats an empty ORCA_PANE_KEY as no self', async () => {
    const { out, port } = await runCli({ ORCA_PANE_KEY: '' }, [{ paneKey: 's:1', behavior: working }]);
    expect(out).not.toContain(SELF_HEADING);
    expect(port.sendsTo('s:1')).toBe(1);
  });

  it('prints the self block between the problem groups and the confirmed group, and no self block without self', async () => {
    const agents: FakeAgent[] = [
      { paneKey: 's:1', behavior: working },
      { paneKey: 'a:1', behavior: repliesWithToken() },
    ];
    const withSelf = await runCli({ ORCA_PANE_KEY: 's:1' }, agents);
    expect(withSelf.code).toBe(0);
    expect(withSelf.port.sendsTo('s:1')).toBe(0);
    expect(withSelf.out).toContain(selfBlock);
    expect(withSelf.out).not.toContain('unconfirmed');
    expect(withSelf.out.indexOf(SELF_HEADING)).toBeLessThan(withSelf.out.indexOf('confirmed (1)'));

    const without = await runCli({}, [{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    expect(without.out).not.toContain(SELF_HEADING);
  });
});

describe('roles in extension and self handling', () => {
  const textTo = (port: FakeOrca, paneKey: string) => port.sends.filter((s) => s.handle === port.handleOf(paneKey)).map((s) => s.text);

  it('re-pauses resumed agents coordinators first and words the coordinator message', async () => {
    const t = await setup([
      { paneKey: 'w:1', behavior: repliesWithToken() },
      { paneKey: 'c:1', behavior: repliesWithToken() },
    ]);
    t.port.coordinatorsAt = () => ['c:1'];
    const resumed = { pauseBaseline: OLD_REPLY, resumeStatus: 'resumed' as const, resumeReason: 'queued-while-working' as const };
    await seedOpenRun(t.store(), [agentRecord('w:1', resumed), agentRecord('c:1', resumed)]);

    const summary = await t.runPause();

    expect(t.port.sends.map((s) => s.handle)).toEqual([t.port.handleOf('c:1'), t.port.handleOf('w:1')]);
    expect(textTo(t.port, 'c:1')).toEqual([pauseMessage(TOKEN, 'coordinator')]);
    expect(textTo(t.port, 'w:1')).toEqual([pauseMessage(TOKEN)]);
    expect(summary.rows.map((r) => [r.paneKey, r.role])).toEqual([['w:1', 'worker'], ['c:1', 'coordinator']]);
  });

  it('never messages a coordinator self, and a later resume sends workers first and self last', async () => {
    const t = await setup([
      { paneKey: 's:1', behavior: working },
      { paneKey: 'w:1', behavior: cycleAgent },
    ]);
    t.port.coordinatorsAt = () => ['s:1'];

    const summary = await t.runPause('s:1');

    expect(textTo(t.port, 's:1')).toEqual([]);
    expect(summary.self).toMatchObject({ paneKey: 's:1', role: 'coordinator', pauseReason: 'self' });

    const resumed = await t.runResume();

    expect(t.port.sends.filter((s) => s.text === continueMessage()).map((s) => s.handle)).toEqual([t.port.handleOf('w:1'), t.port.handleOf('s:1')]);
    expect(resumed.rows.find((r) => r.paneKey === 's:1')).toMatchObject({ resumeStatus: 'resumed', resumeReason: 'queued-while-working' });
  });

  it('hands over a coordinator self by sending it the coordinator pause message', async () => {
    let bIsWorking = false;
    const t = await setup([
      { paneKey: 's:1', behavior: repliesWithToken() },
      { paneKey: 'b:9', behavior: () => (bIsWorking ? { state: 'working', message: null } : { state: 'done', message: 'idle' }) },
      { paneKey: 'w:1', behavior: repliesWithToken() },
    ]);
    t.port.coordinatorsAt = () => ['s:1'];
    await t.runPause('s:1');
    bIsWorking = true;

    const second = await t.runPause('b:9');

    expect(textTo(t.port, 's:1')).toEqual([pauseMessage(TOKEN, 'coordinator')]);
    expect(second.rows.find((r) => r.paneKey === 's:1')).toMatchObject({ role: 'coordinator', pauseStatus: 'confirmed' });
    expect(second.self).toMatchObject({ paneKey: 'b:9' });
  });
});

describe('extending an open run with a reason', () => {
  const textTo = (port: FakeOrca, paneKey: string) => port.sends.filter((s) => s.handle === port.handleOf(paneKey)).map((s) => s.text);
  const seed = (t: Awaited<ReturnType<typeof setup>>, reason?: Run['reason']) =>
    seedOpenRun(t.store(), [agentRecord('a:1', { pauseStatus: 'unconfirmed', pauseReason: 'still-working', pauseBaseline: null, confirmedAt: null, messagePending: true })], reason ? { reason } : {});
  const runPauseWith = (t: Awaited<ReturnType<typeof setup>>, reason?: Preset, confirm?: Confirm) =>
    pause(TIMEOUT, { port: t.port, clock: t.clock, store: t.store(), newToken: () => TOKEN, reason, confirm });

  it('inherits the run reason when no flag is given', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await seed(t, 'limit');
    await runPauseWith(t);
    expect(textTo(t.port, 'a:1')).toEqual([pauseMessage(TOKEN, 'worker', 'limit')]);
    expect((await t.readRun()).reason).toBe('limit');
  });

  it('accepts the same reason', async () => {
    const t = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await seed(t, 'away');
    const summary = await runPauseWith(t, 'away');
    expect(summary.exitCode).toBe(0);
    expect(textTo(t.port, 'a:1')).toEqual([pauseMessage(TOKEN, 'worker', 'away')]);
  });

  const refusals: [string, Run['reason'], Preset, string][] = [
    ['a different reason', 'away', 'limit', 'This run was paused with --reason away; use --reason away, or close it first.'],
    ['an explicit reason on a run without one', undefined, 'network', 'This run was paused without --reason; run pause without --reason, or close it first.'],
  ];
  for (const [name, stored, flag, message] of refusals) {
    it(`refuses ${name}: exit 2, nothing sent, no prompt, record byte-identical`, async () => {
      const t = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
      await seed(t, stored);
      const file = join(t.dir, 'pauses', 'run-1.json');
      const before = await readFile(file, 'utf8');
      let asked = 0;

      const summary = await runPauseWith(t, flag, async () => {
        asked += 1;
        return true;
      });

      expect(summary).toMatchObject({ outcome: 'error', exitCode: 2, run: null, error: message });
      expect(t.port.sends).toHaveLength(0);
      expect(asked).toBe(0);
      expect(await readFile(file, 'utf8')).toBe(before);
    });
  }
});
