import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOrcaAdapter, type Exec } from '../src/orca-adapter.js';
import { pause, pauseMessage } from '../src/pause.js';
import { continueMessage, resume } from '../src/resume.js';
import { createRecordStore } from '../src/store.js';
import type { AgentRecord, Run } from '../src/types.js';
import { type Behavior, type FakeAgent, agentRecord, doneWithToken, fakeClock, FakeOrca, pausedDone, repliesWithToken, seedOpenRun, tempStateDir, working } from './helpers/fake-orca.js';

const TOKEN = 'abcd1234';
const SENTENCE = 'Do not dispatch new workers or tasks.';
const WORKER_MESSAGE = pauseMessage(TOKEN);
const COORDINATOR_MESSAGE = `${WORKER_MESSAGE} ${SENTENCE}`;

async function setupPause(agents: FakeAgent[]) {
  const dir = await tempStateDir();
  const port = new FakeOrca(agents);
  const clock = fakeClock();
  const run = (timeoutMs = 60_000) => pause(timeoutMs, { port, clock, store: createRecordStore(dir), newToken: () => TOKEN });
  const readRun = async (): Promise<Run> => {
    const file = (await readdir(join(dir, 'pauses'))).find((n) => n.endsWith('.json')) ?? '';
    return JSON.parse(await readFile(join(dir, 'pauses', file), 'utf8')) as Run;
  };
  return { port, run, readRun };
}

const handles = (port: FakeOrca) => port.sends.map((s) => s.handle);
const textTo = (port: FakeOrca, paneKey: string) => port.sends.filter((s) => s.handle === port.handleOf(paneKey)).map((s) => s.text);

/** Replies with the token after the first pause message, runs an extra turn (a wake) from the given listing on, and replies with the token again after a second message. */
const wakesAtListing =
  (wakeListing: number): Behavior =>
  ({ received, listCalls }) => {
    if (received.length === 0) return { state: 'working', message: null };
    if (received.length >= 2 || listCalls < wakeListing) return doneWithToken(received, `note ${received.length}`);
    return { state: 'done', message: `extra turn ${received.length}` };
  };

describe('coordinators in pause', () => {
  it('detects a coordinator on the second run-list page through the real adapter and sends it the one-line coordinator message', async () => {
    const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8');
    const terminals = JSON.parse(fixture('terminal-list')).result.terminals as { handle: string; tabId: string; leafId: string }[];
    const agentsInFixture = JSON.parse(fixture('worktree-ps')).result.worktrees.flatMap((w: { agents?: { paneKey: string; state: string }[] }) => w.agents ?? []);
    const workingPane = agentsInFixture.find((a: { state: string }) => a.state === 'working').paneKey;
    const workingHandle = terminals.find((t) => `${t.tabId}:${t.leafId}` === workingPane)!.handle;
    const page1 = JSON.parse(fixture('run-list'));
    page1.result.nextCursor = 'cursor-2';
    const page2 = JSON.parse(fixture('run-list'));
    page2.result.runs = [{ ...page2.result.runs[0], id: 'run_second_page', coordinator_handle: workingHandle }];
    page2.result.nextCursor = null;
    const sent: string[] = [];
    const exec: Exec = async (_file, args) => {
      const key = args.slice(0, 2).join(' ');
      if (key === 'terminal send') sent.push(args[args.indexOf('--text') + 1] as string);
      const body: Record<string, string> = {
        'worktree ps': fixture('worktree-ps'),
        'terminal list': fixture('terminal-list'),
        'orchestration run-list': JSON.stringify(args.includes('--cursor') ? page2 : page1),
        'terminal send': fixture('terminal-send-accepted'),
      };
      return { stdout: body[key] as string, stderr: '', code: 0 };
    };
    const dir = await tempStateDir();

    const summary = await pause(5000, { port: createOrcaAdapter(exec), clock: fakeClock(), store: createRecordStore(dir), newToken: () => TOKEN });

    expect(sent).toEqual([COORDINATOR_MESSAGE]);
    expect(sent[0]).not.toContain('\n');
    expect(sent[0]?.endsWith(SENTENCE)).toBe(true);
    expect(summary.rows.map((r) => r.role)).toEqual(['coordinator']);
    expect(summary.rows.map((r) => r.pauseReason)).not.toContain('send-failed');
    expect(summary.rows.map((r) => r.messagePending)).toEqual([false]);
  });

  it('sends a worker the unchanged pause message and records role worker', async () => {
    const { port, run } = await setupPause([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    const summary = await run();
    expect(textTo(port, 'a:1')).toEqual([WORKER_MESSAGE]);
    expect(summary.rows[0]?.role).toBe('worker');
  });

  it('messages every coordinator before any worker in the first poll', async () => {
    const { port, run } = await setupPause([
      { paneKey: 'w:1', behavior: repliesWithToken() },
      { paneKey: 'c:2', behavior: repliesWithToken() },
      { paneKey: 'w:3', behavior: repliesWithToken() },
    ]);
    port.coordinatorsAt = () => ['c:2'];
    await run();
    expect(handles(port)).toEqual(['term_c:2', 'term_w:1', 'term_w:3']);
    expect(textTo(port, 'c:2')).toEqual([COORDINATOR_MESSAGE]);
  });

  it('sweeps a late coordinator in with the coordinator message and sends it before a late worker listed earlier', async () => {
    const { port, run, readRun } = await setupPause([
      { paneKey: 'a:1', behavior: repliesWithToken() },
      { paneKey: 'w:3', rowAt: (l) => l >= 3, behavior: repliesWithToken() },
      { paneKey: 'c:4', rowAt: (l) => l >= 3, behavior: repliesWithToken() },
    ]);
    port.coordinatorsAt = () => ['c:4'];
    await run();
    expect(handles(port)).toEqual(['term_a:1', 'term_c:4', 'term_w:3']);
    expect(textTo(port, 'c:4')).toEqual([COORDINATOR_MESSAGE]);
    const record = await readRun();
    expect(record.agents.map((a) => [a.paneKey, a.role])).toEqual([['a:1', 'worker'], ['w:3', 'worker'], ['c:4', 'coordinator']]);
  });

  it('re-pauses a woken coordinator with the coordinator message, before a woken worker listed earlier', async () => {
    const { port, run } = await setupPause([
      { paneKey: 'w:1', behavior: wakesAtListing(8) },
      { paneKey: 'c:2', behavior: wakesAtListing(8) },
      { paneKey: 'x:3', behavior: working },
    ]);
    port.coordinatorsAt = () => ['c:2'];
    await run();
    expect(handles(port)).toEqual(['term_c:2', 'term_w:1', 'term_x:3', 'term_c:2', 'term_w:1']);
    expect(textTo(port, 'c:2')).toEqual([COORDINATOR_MESSAGE, COORDINATOR_MESSAGE]);
    expect(textTo(port, 'w:1')).toEqual([WORKER_MESSAGE, WORKER_MESSAGE]);
  });

  const flips: [string, (call: number) => string[], string[], string][] = [
    ['a coordinator that becomes a worker', (call) => (call < 3 ? ['a:1'] : []), [COORDINATOR_MESSAGE, WORKER_MESSAGE], 'worker'],
    ['a worker that becomes a coordinator', (call) => (call < 3 ? [] : ['a:1']), [WORKER_MESSAGE, COORDINATOR_MESSAGE], 'coordinator'],
  ];
  for (const [name, coordinatorsAt, messages, role] of flips) {
    it(`does not trust the stored role: ${name} before its re-pause gets the message of its new role`, async () => {
      const { port, run } = await setupPause([
        { paneKey: 'a:1', behavior: wakesAtListing(6) },
        { paneKey: 'x:2', behavior: working },
      ]);
      port.coordinatorsAt = coordinatorsAt;
      const summary = await run();
      expect(textTo(port, 'a:1')).toEqual(messages);
      expect(summary.rows[0]?.role).toBe(role);
    });
  }

  it('keeps the role of an agent that goes gone', async () => {
    const { port, run } = await setupPause([
      { paneKey: 'a:1', terminalAt: (l) => (l >= 3 ? 'missing' : 'ok'), behavior: working },
      { paneKey: 'x:2', behavior: working },
    ]);
    port.coordinatorsAt = () => ['a:1'];
    const summary = await run(10_000);
    expect(summary.rows[0]).toMatchObject({ resumeStatus: 'gone', role: 'coordinator' });
  });

  it('saves the record, sends nothing and exits 2 when run-list keeps failing in the first poll', async () => {
    const { port, run, readRun } = await setupPause([{ paneKey: 'a:1', behavior: working }]);
    port.failRunListsFrom = 1;
    const summary = await run();
    expect(summary.exitCode).toBe(2);
    expect(summary.error).toContain('run-list');
    expect(port.listRunsCalls).toBe(3);
    expect(port.sends).toEqual([]);
    expect((await readRun()).agents.map((a) => a.paneKey)).toEqual(['a:1']);
  });

  it('stops with exit 2 when a later run-list call fails, sending nothing after it', async () => {
    const { port, run, readRun } = await setupPause([{ paneKey: 'a:1', behavior: working }]);
    port.failRunListsFrom = 2;
    const summary = await run();
    expect(summary.exitCode).toBe(2);
    expect(port.sends).toHaveLength(1);
    expect((await readRun()).agents.map((a) => a.paneKey)).toEqual(['a:1']);
  });

  it('retries a failed run-list call like the other list calls and carries on', async () => {
    const { port, run } = await setupPause([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    port.failRunListAt = 1;
    const summary = await run();
    expect(summary.exitCode).toBe(0);
    expect(port.listRunsCalls).toBe(3); // one failed attempt, its retry, then poll 2
  });

  it('reads run-list once per poll and not for the pre-send read', async () => {
    const { port, run } = await setupPause([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await run();
    expect(port.listCalls).toBe(3); // poll 1, the pre-send read, poll 2
    expect(port.listRunsCalls).toBe(2);
  });

  it('does not read run-list when there is nothing to pause', async () => {
    const { port, run } = await setupPause([{ paneKey: 'a:1', behavior: pausedDone() }]);
    const summary = await run();
    expect(summary.outcome).toBe('nothing-to-do');
    expect(port.listRunsCalls).toBe(0);
  });
});

async function setupResume(agents: FakeAgent[], records: AgentRecord[]) {
  const dir = await tempStateDir();
  await seedOpenRun(createRecordStore(dir), records);
  const port = new FakeOrca(agents);
  const go = (signal?: AbortSignal) => resume({ port, clock: fakeClock(), store: createRecordStore(dir), signal });
  const file = join(dir, 'pauses', 'run-1.json');
  return { port, go, file, readRun: async (): Promise<Run> => JSON.parse(await readFile(file, 'utf8')) as Run };
}

describe('coordinators in resume', () => {
  const idle = (paneKey: string): FakeAgent => ({ paneKey, behavior: pausedDone() });

  it('sends the continue message to every worker before any coordinator, the same text for both', async () => {
    const { port, go } = await setupResume([idle('c:1'), idle('w:2'), idle('w:3')], [agentRecord('c:1', { role: 'coordinator' }), agentRecord('w:2'), agentRecord('w:3')]);
    port.coordinatorsAt = () => ['c:1'];
    await go();
    expect(port.sends).toEqual([
      { handle: 'term_w:2', text: continueMessage() },
      { handle: 'term_w:3', text: continueMessage() },
      { handle: 'term_c:1', text: continueMessage() },
    ]);
  });

  it('does not trust the stored role: it sends in the order of the fresh role and updates the record', async () => {
    const { port, go, readRun } = await setupResume([idle('a:1'), idle('b:2')], [agentRecord('a:1', { role: 'worker' }), agentRecord('b:2', { role: 'coordinator' })]);
    port.coordinatorsAt = () => ['a:1'];
    await go();
    expect(handles(port)).toEqual(['term_b:2', 'term_a:1']);
    expect((await readRun()).agents.map((a) => [a.paneKey, a.role])).toEqual([['a:1', 'coordinator'], ['b:2', 'worker']]);
  });

  it('leaves the records of agents it never reached untouched when a signal stops it between role-ordered sends', async () => {
    const records = [agentRecord('a:1'), agentRecord('b:2', { resumeReason: 'send-failed' }), agentRecord('c:3', { resumeReason: 'send-failed' })];
    const { port, go, readRun } = await setupResume([idle('a:1'), idle('b:2'), { paneKey: 'c:3', hasTerminal: false, behavior: working }], records);
    port.coordinatorsAt = () => ['b:2'];
    const abort = new AbortController();
    port.onSend = () => abort.abort('SIGHUP');
    const summary = await go(abort.signal);
    expect(summary.exitCode).toBe(130);
    expect(port.sends).toHaveLength(1);
    const [, b, c] = (await readRun()).agents;
    expect(b).toEqual(records[1]); // still role worker: its fresh role was never written
    expect(c).toEqual(records[2]); // still pending: its gone mark was never written
  });

  it('keeps the stored role of an agent that is gone', async () => {
    const { port, go, readRun } = await setupResume([{ paneKey: 'c:1', hasTerminal: false, behavior: working }], [agentRecord('c:1', { role: 'coordinator' })]);
    await go();
    expect(port.sends).toEqual([]);
    expect((await readRun()).agents[0]).toMatchObject({ resumeStatus: 'gone', role: 'coordinator' });
  });

  it('exits 2 with the record unchanged and nothing sent when run-list fails', async () => {
    const { port, go, file } = await setupResume([idle('a:1')], [agentRecord('a:1')]);
    const before = await readFile(file, 'utf8');
    port.failRunListsFrom = 1;
    const summary = await go();
    expect(summary.exitCode).toBe(2);
    expect(port.sends).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('does not read run-list when there is no open run', async () => {
    const port = new FakeOrca([idle('a:1')]);
    const summary = await resume({ port, clock: fakeClock(), store: createRecordStore(await tempStateDir()) });
    expect(summary.outcome).toBe('nothing-to-do');
    expect(port.listRunsCalls).toBe(0);
  });
});
