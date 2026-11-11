import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { continueMessage, resume } from '../src/resume.js';
import { createRecordStore } from '../src/store.js';
import type { AgentRecord, ConfirmTarget, Run, TranscriptIdentity, TranscriptMark } from '../src/types.js';
import { type Behavior, type FakeAgent, fakeClock, FakeOrca, PAUSED_REPLY, seedOpenRun, tempStateDir, working } from './helpers/fake-orca.js';
import { scanOf } from './helpers/roster.js';
import { runCli } from './helpers/run-cli.js';

const PANE = 'a:1';
const SESSION = 's1';
const identity: TranscriptIdentity = { sessionId: SESSION, cwd: '/work/tree-a:1', configDir: '/cfg', pid: 10, startTime: 5 };
const CONTINUE = continueMessage();

/** Done with the pause reply; after any message, done with a new reply (a wake-up turn changes the reply as a CONTINUE would). */
const woken: Behavior = ({ received }) => ({ state: 'done', message: received.length === 0 ? PAUSED_REPLY : 'Woken by a task.' });
const idle: Behavior = () => ({ state: 'done', message: PAUSED_REPLY });

function agentRecord(extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    paneKey: PANE,
    repoId: 'repo-repo',
    repo: 'repo',
    worktreeId: `wt-${PANE}`,
    worktreePath: `/work/tree-${PANE}`,
    worktree: `tree-${PANE}`,
    role: 'worker',
    orchestrationRunIds: [],
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

const mark = (over: Partial<TranscriptMark> = {}): TranscriptMark => ({ identity, position: 0, fileId: 'gen-1', ...over });

interface Options {
  agents?: FakeAgent[];
  record?: Partial<AgentRecord>;
  /** Runs before the command; the default gives the agent a scan record with an identity and an empty transcript. */
  configure?: (port: FakeOrca) => void;
  scan?: boolean;
  confirm?: (targets: ConfirmTarget[]) => boolean;
  onSleep?: (n: number, port: FakeOrca) => void;
}

async function run(behavior: Behavior, options: Options = {}) {
  const dir = await tempStateDir();
  const store = createRecordStore(dir);
  await seedOpenRun(store, [agentRecord(options.record)]);
  const port = new FakeOrca(options.agents ?? [{ paneKey: PANE, behavior }]);
  if (options.scan !== false) {
    port.scanAt = () => scanOf({ sessionId: SESSION, paneKey: PANE, cwd: identity.cwd, startTime: 5, transcript: identity });
    port.transcript(SESSION);
  }
  options.configure?.(port);
  const clock = fakeClock();
  let sleeps = 0;
  clock.onSleep = () => {
    sleeps += 1;
    options.onSleep?.(sleeps, port);
  };
  const confirmed: ConfirmTarget[][] = [];
  const confirm = options.confirm ? async (targets: ConfirmTarget[]) => (confirmed.push(targets), (options.confirm as (t: ConfirmTarget[]) => boolean)(targets)) : undefined;
  const summary = await resume({ port, clock, store: createRecordStore(dir), ...(confirm ? { confirm } : {}) });
  const saved = JSON.parse(await readFile(join(dir, 'pauses', 'run-1.json'), 'utf8')) as Run;
  return { port, summary, saved, agent: saved.agents[0] as AgentRecord, confirmed, dir };
}

describe('resume: the CONTINUE transcript proof', () => {
  it('marks an agent resumed when its transcript shows the CONTINUE user entry', async () => {
    const { summary, agent } = await run(woken, { configure: (p) => { p.onSend = () => void p.transcript(SESSION).user(`[wrapper] ${CONTINUE}`); } });
    expect(summary.exitCode).toBe(0);
    expect(agent).toMatchObject({ resumeStatus: 'resumed' });
    expect(agent.continueTexts).toEqual([CONTINUE]);
    expect(agent.continueTranscript).toMatchObject({ identity, fileId: 'gen-1' });
  });

  it('leaves an agent pending when only a wake-up turn follows, although its reply changed', async () => {
    const { summary, agent } = await run(woken, { configure: (p) => { p.onSend = () => void p.transcript(SESSION).reply('Woken by a task.'); } });
    expect(summary.exitCode).toBe(1);
    expect(agent).toMatchObject({ resumeStatus: 'pending', resumeReason: 'no-proof' });
  });

  it('uses today\'s change check when the agent has no transcript identity', async () => {
    const { summary, agent } = await run(woken, { scan: false });
    expect(summary.exitCode).toBe(0);
    expect(agent).toMatchObject({ resumeStatus: 'resumed' });
    expect(agent.continueTranscript).toBeUndefined();
    expect(agent.continueTexts).toBeUndefined();
  });

  const missing: [string, (p: FakeOrca) => void, Partial<Options>][] = [
    ['the file is gone', (p) => void p.transcript(SESSION).remove(), {}],
    ['the file shrank', (p) => void p.transcript(SESSION).shrink(1), { configure: (p) => void p.transcript(SESSION).user('earlier') }],
    ['the file was replaced', (p) => void p.transcript(SESSION).replace(), {}],
    ['the session file is absent or invalid', (p) => void p.transcript(SESSION).lose(), {}],
    ['the process start time changed', (p) => void p.transcript(SESSION).lose(), {}],
    ['the session has a new session ID', (p) => void p.transcript(SESSION).lose(), {}],
  ];
  it.each(missing)('falls back to today\'s change check when %s', async (_name, change, extra) => {
    const { summary, agent } = await run(woken, { ...extra, configure: (p) => { extra.configure?.(p); p.onSend = () => change(p); } });
    expect(summary.exitCode).toBe(0);
    expect(agent).toMatchObject({ resumeStatus: 'resumed' });
  });

  it('falls back to today\'s check when the scan has no entry for the pane', async () => {
    const { summary, agent } = await run(woken, { configure: (p) => { p.scanAt = () => scanOf({ sessionId: 'other', paneKey: 'z:9', cwd: '/x', startTime: 1, transcript: { ...identity, sessionId: 'other' } }); } });
    expect(summary.exitCode).toBe(0);
    expect(agent.continueTranscript).toBeUndefined();
  });

  it('falls back to today\'s check when the start scan fails', async () => {
    const { summary, agent } = await run(woken, { configure: (p) => { p.failScansFrom = 1; } });
    expect(summary.exitCode).toBe(0);
    expect(agent.continueTranscript).toBeUndefined();
  });

  it('proves a re-run from the first text although the second send has another text', async () => {
    const first = continueMessage(undefined, [{ sessionId: 'w1', name: 'w' } as never]);
    const { port, summary, agent } = await run(idle, {
      record: { continueTranscript: mark(), continueTexts: [first], continueSentAt: '2026-01-01T00:01:00.000Z', continueBaseline: { stateStartedAt: 1, lastAssistantMessage: PAUSED_REPLY } },
      configure: (p) => void p.transcript(SESSION).user(first),
    });
    expect(summary.exitCode).toBe(0);
    expect(agent.resumeStatus).toBe('resumed');
    expect(port.sends).toEqual([]);
  });

  it('adds the text of a re-send and keeps the first mark', async () => {
    const other = 'an earlier CONTINUE text';
    const { agent, port } = await run(idle, {
      record: { continueTranscript: mark({ position: 3 }), continueTexts: [other], continueSentAt: '2026-01-01T00:01:00.000Z', continueBaseline: { stateStartedAt: 1, lastAssistantMessage: 'stale' } },
      configure: (p) => { p.transcript(SESSION).user('a').user('b').user('c'); },
    });
    expect(port.sends).toHaveLength(1);
    expect(agent.continueTranscript).toEqual(mark({ position: 3 }));
    expect(agent.continueTexts).toEqual([other, CONTINUE]);
  });

  it('keeps a proof after the transcript is removed', async () => {
    const { agent } = await run(woken, {
      configure: (p) => { p.onSend = () => void p.transcript(SESSION).user(CONTINUE); },
      onSleep: (n, p) => { if (n === 1) p.transcript(SESSION).remove(); },
    });
    expect(agent.resumeStatus).toBe('resumed');
  });

  it('reads each poll from the position of the previous read', async () => {
    const { port, agent } = await run(woken, {
      configure: (p) => { p.onSend = () => void p.transcript(SESSION).reply('r0'); },
      onSleep: (n, p) => { if (n < 4) p.transcript(SESSION).reply(`r${n}`); if (n === 4) p.transcript(SESSION).user(CONTINUE); },
    });
    const reads = port.transcriptReads.filter((r) => r.fileId !== null).map((r) => r.position);
    expect(agent.resumeStatus).toBe('resumed');
    expect(reads.length).toBeGreaterThan(2);
    expect(reads[0]).toBe(0);
    expect(reads.slice(1).every((position, i) => position > (reads[i] as number))).toBe(true);
  });

  it('reads with the identity of its own start scan, not the one stored by the pause run', async () => {
    const stale = mark({ identity: { ...identity, pid: 10 } });
    const { port, agent } = await run(woken, {
      record: { pauseTranscript: stale },
      configure: (p) => {
        p.scanAt = () => scanOf({ sessionId: SESSION, paneKey: PANE, cwd: identity.cwd, startTime: 5, transcript: { ...identity, pid: 99 } });
        p.onSend = () => void p.transcript(SESSION).user(CONTINUE);
      },
    });
    expect(agent.resumeStatus).toBe('resumed');
    expect(port.transcriptReads.map((r) => r.identity.pid)).toEqual(expect.arrayContaining([99]));
    expect(port.transcriptReads.every((r) => r.identity.pid === 99)).toBe(true);
  });

  const present = { continueTranscript: mark(), continueTexts: [CONTINUE], continueSentAt: '2026-01-01T00:01:00.000Z', continueBaseline: { stateStartedAt: 1, lastAssistantMessage: PAUSED_REPLY } };

  it('sees an entry that is already present at the confirmation: no target, no send', async () => {
    const { port, confirmed, agent } = await run(idle, { record: present, configure: (p) => void p.transcript(SESSION).user(CONTINUE), confirm: () => true });
    expect(confirmed).toEqual([]);
    expect(port.sends).toEqual([]);
    expect(agent.resumeStatus).toBe('resumed');
  });

  it('remembers the match of the confirmation, so the check before the send does not send again', async () => {
    const { port, agent } = await run(idle, { record: { ...present, role: 'worker' }, configure: (p) => void p.transcript(SESSION).user(CONTINUE), confirm: () => true });
    expect(port.sends).toEqual([]);
    expect(agent.resumeStatus).toBe('resumed');
  });

  it('sees an entry that is already present at the check before a send', async () => {
    const { port, agent } = await run(idle, { record: present, configure: (p) => void p.transcript(SESSION).user(CONTINUE) });
    expect(port.sends).toEqual([]);
    expect(agent.resumeStatus).toBe('resumed');
  });

  it('keeps an agent whose older record has no mark on today\'s change check, with no new CONTINUE', async () => {
    const { port, agent } = await run(woken, { record: { continueSentAt: '2026-01-01T00:01:00.000Z', continueBaseline: { stateStartedAt: 1, lastAssistantMessage: 'before' } } });
    expect(port.sends).toEqual([]);
    expect(agent.resumeStatus).toBe('resumed');
  });

  it('stores a mark and the text on the re-send of an older record that has an identity now', async () => {
    const { agent } = await run(idle, { record: { continueSentAt: '2026-01-01T00:01:00.000Z', continueBaseline: { stateStartedAt: 1, lastAssistantMessage: PAUSED_REPLY } } });
    expect(agent.continueTranscript).toMatchObject({ identity, fileId: 'gen-1' });
    expect(agent.continueTexts).toEqual([CONTINUE]);
  });

  it('stores no mark and no text when the send fails', async () => {
    const { agent } = await run(idle, { configure: (p) => { p.sendResult = () => ({ accepted: false, reason: 'refused' }); } });
    expect(agent.resumeReason).toBe('send-failed');
    expect(agent.continueTranscript).toBeUndefined();
    expect(agent.continueTexts).toBeUndefined();
  });

  it('keeps the queued-while-working fast path', async () => {
    const { summary, agent } = await run(working);
    expect(summary.exitCode).toBe(0);
    expect(agent).toMatchObject({ resumeStatus: 'resumed', resumeReason: 'queued-while-working' });
  });

  it('adds no session scan', async () => {
    const withTranscript = await run(woken, { configure: (p) => { p.onSend = () => void p.transcript(SESSION).user(CONTINUE); } });
    const without = await run(woken, { scan: false });
    expect(withTranscript.port.scanCalls).toBe(without.port.scanCalls);
  });

  it('holds no transcript text in the saved run', async () => {
    const { saved } = await run(woken, { configure: (p) => { p.onSend = () => void p.transcript(SESSION).user(`${CONTINUE} SECRET-FROM-TRANSCRIPT`); } });
    expect(JSON.stringify(saved)).not.toContain('SECRET-FROM-TRANSCRIPT');
  });
});

describe('pause: a re-pause clears the CONTINUE proof', () => {
  it('clears the CONTINUE mark and the stored texts when it pauses the agent again', async () => {
    const record = agentRecord({ continueTranscript: mark(), continueTexts: [CONTINUE], continueSentAt: '2026-01-01T00:01:00.000Z', continueBaseline: { stateStartedAt: 1, lastAssistantMessage: PAUSED_REPLY } });
    const woke: Behavior = ({ received }) => (received.length === 0 ? { state: 'done', message: 'Back at work.' } : { state: 'working', message: null });
    const { dir } = await runCli(['pause', '--yes', '--timeout', '10s'], [{ paneKey: PANE, behavior: woke }], { newToken: () => 'abcd1234', seed: (store) => seedOpenRun(store, [record]) });
    const saved = JSON.parse(await readFile(join(dir, 'orca-broadcast', 'pauses', 'run-1.json'), 'utf8')) as Run;
    const agent = saved.agents[0] as AgentRecord;
    expect(agent.wakeCount).toBe(1);
    expect(agent.continueTranscript).toBeUndefined();
    expect(agent.continueTexts).toBeUndefined();
    expect(agent.continueSentAt).toBeUndefined();
  });
});
