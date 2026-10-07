import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pause, pauseMessage } from '../src/pause.js';
import { renderTable } from '../src/render.js';
import { createRecordStore } from '../src/store.js';
import type { Preset } from '../src/reasons.js';
import type { Progress, Run } from '../src/types.js';
import { type Behavior, type FakeAgent, doneWithToken, fakeClock, FakeOrca, repliesAfter, repliesWithToken, tempStateDir, tokenOf, working } from './helpers/fake-orca.js';

const TIMEOUT = 60_000;

async function setup(agents: FakeAgent[]) {
  const dir = await tempStateDir();
  const port = new FakeOrca(agents);
  const clock = fakeClock();
  const run = (timeoutMs = TIMEOUT, newToken?: () => string, signal?: AbortSignal) =>
    pause(timeoutMs, { port, clock, store: createRecordStore(dir), newToken, signal });
  return { dir, port, clock, run };
}

async function readRuns(dir: string): Promise<Run[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8')) as Run));
}

describe('pause happy path', () => {
  it('messages three working agents once each, confirms them and exits 0', async () => {
    const { dir, port, run } = await setup([
      { paneKey: 'a:1', behavior: repliesWithToken() },
      { paneKey: 'b:2', behavior: repliesWithToken('All saved.\r\n') },
      { paneKey: 'c:3', behavior: repliesWithToken() },
    ]);

    const summary = await run();

    expect(summary.exitCode).toBe(0);
    expect(summary.outcome).toBe('done');
    expect(port.sends).toHaveLength(3);
    for (const key of ['a:1', 'b:2', 'c:3']) expect(port.sendsTo(key)).toBe(1);
    expect(summary.rows.map((r) => r.pauseStatus)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    const [record] = await readRuns(dir);
    expect(record?.status).toBe('open');
    expect(record?.agents.every((a) => a.pauseStatus === 'confirmed' && a.confirmedAt && a.pauseReason === null)).toBe(true);
  });

  it('ends as soon as every agent is confirmed, reading one listing per poll plus one per send', async () => {
    const { clock, port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await run();
    expect(port.listCalls).toBe(3); // poll 1, the pre-send read, poll 2
    expect(clock.slept).toBe(2000);
  });

  it('runs no poll at the deadline: a 5s timeout polls at 0s, 2s and 4s', async () => {
    const { clock, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    await run(5000);
    expect(port.listCalls).toBe(4); // polls at 0s, 2s, 4s plus one pre-send read
    expect(clock.slept).toBe(6000);
  });

  it('keeps agents unconfirmed when they end done without the token or with an unchanged message', async () => {
    const noToken: Behavior = ({ received }) =>
      received.length ? { state: 'done', message: 'I stopped but forgot the line' } : { state: 'working', message: null };
    const sameAsBaseline: Behavior = ({ received }) => {
      return received.length ? { state: 'done', message: 'old reply\nORCA-PAUSED deadbeef' } : { state: 'working', message: 'old reply\nORCA-PAUSED deadbeef' };
    };
    const { clock, port, run } = await setup([
      { paneKey: 'a:1', behavior: noToken },
      { paneKey: 'b:2', behavior: sameAsBaseline },
      { paneKey: 'c:3', behavior: repliesWithToken() },
    ]);

    const summary = await run(TIMEOUT, () => 'deadbeef');

    expect(summary.exitCode).toBe(1);
    const byKey = Object.fromEntries(summary.rows.map((r) => [r.paneKey, r]));
    expect(byKey['a:1']).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'done-no-token' });
    expect(byKey['b:2']).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'done-no-token' });
    expect(byKey['c:3']).toMatchObject({ pauseStatus: 'confirmed' });
    expect(clock.slept).toBeGreaterThanOrEqual(TIMEOUT);
    expect(port.sends).toHaveLength(3);
  });

  it('reports still-working and waiting-permission agents as unconfirmed at timeout', async () => {
    const { run } = await setup([
      { paneKey: 'a:1', behavior: working },
      { paneKey: 'b:2', behavior: ({ received }) => (received.length ? { state: 'waiting', message: null } : { state: 'working', message: null }) },
    ]);
    const summary = await run();
    expect(summary.exitCode).toBe(1);
    expect(summary.rows.map((r) => r.pauseReason)).toEqual(['still-working', 'waiting-permission']);
  });

  it('writes the record and the pointer before the first send', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    let seen: { pointer: string; runs: Run[] } | null = null;
    port.onSend = async () => {
      seen ??= { pointer: (await readFile(join(dir, 'current'), 'utf8')).trim(), runs: await readRuns(dir) };
    };

    await run();

    expect(seen).not.toBeNull();
    const first = seen as unknown as { pointer: string; runs: Run[] };
    expect(first.runs).toHaveLength(1);
    expect(first.pointer).toBe(first.runs[0]?.runId);
    expect(first.runs[0]?.agents.map((a) => a.paneKey)).toEqual(['a:1']);
  });

  it('sends the exact one-line message for a known token', async () => {
    const { port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await run(TIMEOUT, () => 'abcd1234');
    const text = port.sends[0]?.text ?? '';
    expect(text).toBe(pauseMessage('abcd1234'));
    expect(text).toBe(
      '[orca-broadcast] The user asked all agents to pause. Finish the step you are on now. Do not start a new step and do not commit. Then end your turn with a short note: where you stopped, and your next step. The last line of your reply must be exactly: ORCA-PAUSED abcd1234. If a background task or notification wakes you before that, do not act on it: reply with one short line, and end that reply with the same last line. After that, do nothing until you get a message that starts with [orca-broadcast] CONTINUE.',
    );
    expect(text).not.toMatch(/[\r\n]/);
  });

  it('uses a new 8-character lowercase hexadecimal token per run', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
      await run();
      tokens.push(tokenOf(port.sends[0]?.text ?? ''));
    }
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{8}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});

describe('proof of pause line matching', () => {
  const cases: [string, (t: string) => string, boolean][] = [
    ['LF', (t) => `note\nORCA-PAUSED ${t}`, true],
    ['CRLF', (t) => `note\r\nORCA-PAUSED ${t}\r\n`, true],
    ['surrounding whitespace', (t) => `note\n   ORCA-PAUSED ${t}  `, true],
    ['one pair of backticks', (t) => `note\n\`ORCA-PAUSED ${t}\``, true],
    ['trailing blank lines', (t) => `note\nORCA-PAUSED ${t}\n\n  \n`, true],
    ['wrong token', () => 'note\nORCA-PAUSED 00000000', false],
    ['token line not last', (t) => `ORCA-PAUSED ${t}\nand then more text`, false],
    ['two pairs of backticks', (t) => `note\n\`\`ORCA-PAUSED ${t}\`\``, false],
    ['extra text on the line', (t) => `note\nORCA-PAUSED ${t} done`, false],
  ];
  for (const [name, reply, confirmed] of cases) {
    it(`${confirmed ? 'accepts' : 'rejects'} ${name}`, async () => {
      const behavior: Behavior = ({ received }) =>
        received.length ? { state: 'done', message: reply(tokenOf(received[0] as string)) } : { state: 'working', message: null };
      const { run } = await setup([{ paneKey: 'a:1', behavior }]);
      const summary = await run(10_000);
      expect(summary.rows[0]?.pauseStatus).toBe(confirmed ? 'confirmed' : 'unconfirmed');
    });
  }

  it('accepts a token reply while the agent is still working, as a background task keeps Orca in working', async () => {
    const behavior: Behavior = ({ received }) =>
      received.length ? { state: 'working', message: `note\nORCA-PAUSED ${tokenOf(received[0] as string)}` } : { state: 'working', message: null };
    const { run } = await setup([{ paneKey: 'a:1', behavior }]);
    expect((await run(10_000)).rows[0]).toMatchObject({ pauseStatus: 'confirmed', pauseReason: null });
  });

  for (const state of ['waiting', 'blocked']) {
    it(`does not accept a token reply while the agent is in state ${state}`, async () => {
      const behavior: Behavior = ({ received }) =>
        received.length ? { state, message: `note\nORCA-PAUSED ${tokenOf(received[0] as string)}` } : { state: 'working', message: null };
      const { run } = await setup([{ paneKey: 'a:1', behavior }]);
      expect((await run(10_000)).rows[0]).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'waiting-permission' });
    });
  }
});

describe('staying paused', () => {
  /** Confirms with the token, then (from the third listing after the message) shows what `after` returns. */
  const confirmsThen = (after: (received: string[], n: number) => { state: string; message: string | null }): Behavior => {
    let n = 0;
    return ({ received }) => {
      if (received.length === 0) return { state: 'working', message: null };
      n += 1;
      return n <= 2 ? doneWithToken(received, 'Stopped.') : after(received, n);
    };
  };
  const runLong = async (behavior: Behavior) => {
    const t = await setup([
      { paneKey: 'a:1', behavior },
      { paneKey: 'b:2', behavior: repliesAfter(20) }, // keeps the wait loop running
    ]);
    return { ...t, summary: await t.run() };
  };

  it('keeps a confirmed agent confirmed when it is woken and its new reply still ends with the token line', async () => {
    const { port, summary } = await runLong(
      confirmsThen((received, n) => (n < 6 ? { state: 'working', message: null } : doneWithToken(received, 'Still paused.'))),
    );
    expect(port.sendsTo('a:1')).toBe(1);
    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'confirmed', pauseReason: null, wakeCount: 0, pauseBaseline: expect.stringContaining('Stopped.') });
    expect(summary.exitCode).toBe(0);
  });

  for (const state of ['working', 'waiting', 'done']) {
    it(`does not wake a confirmed agent in state ${state} whose reply is null mid-turn`, async () => {
      const { port, summary } = await runLong(confirmsThen(() => ({ state, message: null })));
      expect(port.sendsTo('a:1')).toBe(1);
      expect(summary.rows[0]).toMatchObject({ pauseStatus: 'confirmed', wakeCount: 0 });
    });
  }

  for (const state of ['working', 'waiting']) {
    it(`does not wake a confirmed agent in state ${state} with its unchanged token reply`, async () => {
      const { port, summary } = await runLong(confirmsThen((received) => ({ state, message: `Stopped.\nORCA-PAUSED ${tokenOf(received[0] as string)}` })));
      expect(port.sendsTo('a:1')).toBe(1);
      expect(summary.rows[0]).toMatchObject({ pauseStatus: 'confirmed', wakeCount: 0 });
    });
  }

  it('re-pauses a confirmed agent once when its newer reply has no token line', async () => {
    const { port, summary } = await runLong(confirmsThen(() => ({ state: 'done', message: 'I started a new task.' })));
    expect(port.sendsTo('a:1')).toBe(2);
    expect(summary.rows[0]).toMatchObject({ wakeCount: 1 });
  });
});

describe('discovery', () => {
  it('prints nothing to pause, creates no run and sends nothing when no Claude agent is working', async () => {
    const { dir, port, run } = await setup([
      { paneKey: 'a:1', behavior: () => ({ state: 'done', message: 'x' }) },
      { paneKey: 'b:2', behavior: () => ({ state: 'waiting', message: null }) },
      { paneKey: 'c:3', agentType: 'codex', behavior: working },
    ]);

    const summary = await run();

    expect(summary).toMatchObject({ outcome: 'nothing-to-do', exitCode: 0, run: null });
    expect(port.sends).toHaveLength(0);
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('messages only working Claude agents', async () => {
    const { port, run } = await setup([
      { paneKey: 'a:1', behavior: repliesWithToken() },
      { paneKey: 'b:2', behavior: () => ({ state: 'done', message: 'x' }) },
      { paneKey: 'c:3', agentType: 'codex', behavior: working },
    ]);
    await run();
    expect(port.sends.map((s) => s.handle)).toEqual([port.handleOf('a:1')]);
  });

  it('uses the row with the newest stateStartedAt when rows share a paneKey', async () => {
    const { port, run } = await setup([
      { paneKey: 'a:1', stateStartedAt: 10, behavior: working },
      { paneKey: 'a:1', stateStartedAt: 20, behavior: () => ({ state: 'done', message: 'x' }) },
    ]);
    const summary = await run();
    expect(summary.outcome).toBe('nothing-to-do');
    expect(port.sends).toHaveLength(0);
  });

  it('applies the newest-row rule to every poll, not only to discovery', async () => {
    const { port, run } = await setup([{ paneKey: 'a:1', stateStartedAt: 20, behavior: working }]);
    port.extraRows = [
      { paneKey: 'a:1', worktreeId: 'w', worktree: 'w', repo: 'r', agentType: 'claude', state: 'done', stateStartedAt: 5, lastAssistantMessage: 'old\nORCA-PAUSED abcd1234' },
    ];
    const summary = await run(10_000, () => 'abcd1234');
    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'still-working' });
  });

  it('records a working agent with no terminal as gone and sends nothing to it', async () => {
    const { port, run } = await setup([{ paneKey: 'a:1', hasTerminal: false, behavior: working }]);
    const summary = await run();
    expect(summary.exitCode).toBe(1);
    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'unconfirmed', resumeStatus: 'gone', resumeReason: 'terminal-closed', lastHandle: null });
    expect(port.sends).toHaveLength(0);
  });
});

describe('failures', () => {
  it('marks a not-accepted send as send-failed and never retries it', async () => {
    const { port, run } = await setup([
      { paneKey: 'a:1', behavior: repliesWithToken() },
      { paneKey: 'b:2', behavior: working },
    ]);
    port.sendResult = (handle) => (handle === port.handleOf('a:1') ? { accepted: false, reason: 'terminal_handle_stale' } : { accepted: true });

    const summary = await run();

    expect(port.sendsTo('a:1')).toBe(1);
    expect(port.sendsTo('b:2')).toBe(1);
    expect(summary.exitCode).toBe(1);
    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'send-failed', messagePending: true });
  });

  it('stops with exit 2 and saves the record when a listing fails mid-run', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    port.onSend = () => {
      port.listError = new Error('orca-ide worktree ps failed: boom');
    };

    const summary = await run();

    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2 });
    expect(summary.error).toContain('boom');
    expect((await readRuns(dir))[0]?.agents[0]?.messagePending).toBe(false);
  });

  it('exits 2 without creating a run when the first listing fails', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    port.listError = new Error('orca-ide missing');
    const summary = await run();
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2, run: null });
    await expect(readdir(dir)).rejects.toThrow();
  });
});

describe('earlier runs', () => {
  const openRun: Run = { runId: 'old-run', token: 'cafebabe', startedAt: '2026-01-01T00:00:00.000Z', status: 'open', agents: [] };

  it('starts a new run when every earlier run is closed', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    const store = createRecordStore(dir);
    await store.save({ ...openRun, status: 'closed' });
    await store.setCurrent('old-run');

    const summary = await run();

    expect(summary.exitCode).toBe(0);
    expect(port.sends).toHaveLength(1);
    expect((await readFile(join(dir, 'current'), 'utf8')).trim()).toBe(summary.run?.runId);
  });
});

describe('robust wait loop', () => {

  /** Confirms after each pause message, then runs a new turn two listings later (a wake); `final` makes the last wake end with a fresh token reply. */
  const wakesAfterConfirm = (final = false): Behavior => {
    let calls = 0;
    let lastLen = 0;
    return ({ received }) => {
      if (received.length === 0) return { state: 'working', message: null };
      if (received.length !== lastLen) {
        lastLen = received.length;
        calls = 0;
      }
      calls += 1;
      if (calls <= 2) return doneWithToken(received, `note ${received.length}`); // confirms in the first two listings
      // After the second wake, once the agent has been marked re-woken, it ends with a fresh token reply.
      if (final && received.length === 2 && calls >= 8) return doneWithToken(received, 'final');
      return { state: 'done', message: `extra turn ${received.length}-${calls}` };
    };
  };

  describe('re-check reason table', () => {
    // One case per row of the spec table, read from the reason at timeout. The row "messagePending true, state
    // working or done -> still-working" lasts less than one poll (the agent is delivered in the same poll), so it
    // cannot be observed from outside.
    const afterMessage = (state: string, message: string | null): Behavior => ({ received }) =>
      received.length ? { state, message } : { state: 'working', message: null };
    const rows: [string, FakeAgent['behavior'], string][] = [
      ['messagePending false, working', afterMessage('working', null), 'still-working'],
      ['messagePending false, done', afterMessage('done', 'no token here'), 'done-no-token'],
      ['messagePending false, waiting', afterMessage('waiting', null), 'waiting-permission'],
      ['messagePending false, unknown state', afterMessage('blocked', null), 'waiting-permission'],
      ['messagePending true, waiting', ({ listCalls }) => ({ state: listCalls === 1 ? 'working' : 'waiting', message: null }), 'waiting-permission'],
      ['re-woken is kept', wakesAfterConfirm(), 're-woken'],
    ];
    for (const [name, behavior, reason] of rows) {
      it(`${name} -> ${reason}`, async () => {
        const { run } = await setup([{ paneKey: 'a:1', behavior }, { paneKey: 'b:2', behavior: working }]);
        expect((await run(20_000)).rows[0]?.pauseReason).toBe(reason);
      });
    }

    it('messagePending true, send-failed is kept -> send-failed', async () => {
      const { port, run } = await setup([{ paneKey: 'a:1', behavior: working }, { paneKey: 'b:2', behavior: working }]);
      port.sendResult = (handle) => (handle === port.handleOf('a:1') ? { accepted: false, reason: 'terminal_handle_stale' } : { accepted: true });
      const summary = await run(20_000);
      expect(summary.rows[0]).toMatchObject({ pauseReason: 'send-failed', messagePending: true });
    });
  });

  it('sweeps an agent that starts working mid-wait and messages it in the same poll', async () => {
    const { dir, port, clock, run } = await setup([
      { paneKey: 'a:1', behavior: repliesWithToken() },
      { paneKey: 'b:2', rowAt: (l) => l >= 3, behavior: repliesWithToken() },
    ]);
    let atSend: { slept: number; recorded: boolean } | null = null;
    port.onSend = async () => {
      if (port.sends.length !== 1) return; // the second send, to b:2
      const runs = await readRuns(dir);
      atSend = { slept: clock.slept, recorded: runs[0]?.agents.some((a) => a.paneKey === 'b:2') ?? false };
    };

    const summary = await run();

    expect(port.sendsTo('b:2')).toBe(1);
    expect(atSend).toEqual({ slept: 2000, recorded: true });
    expect(summary.rows.map((r) => [r.paneKey, r.pauseStatus])).toEqual([['a:1', 'confirmed'], ['b:2', 'confirmed']]);
    expect(summary.rows[1]).toMatchObject({ resumeStatus: 'pending', wakeCount: 0 });
    expect(summary.rows[1]?.resumeReason).toBeUndefined();
    expect(summary.exitCode).toBe(0);
  });

  it('re-pauses a confirmed agent on its first wake, then marks it re-woken on the second wake without a message', async () => {
    const { port, run } = await setup([
      { paneKey: 'a:1', behavior: wakesAfterConfirm() },
      { paneKey: 'b:2', behavior: working },
    ]);

    const summary = await run();

    expect(port.sendsTo('a:1')).toBe(2);
    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 're-woken', wakeCount: 2, confirmedAt: null });
    expect(summary.exitCode).toBe(1);
  });

  it('lets a re-woken agent confirm again with a newer token reply', async () => {
    const { port, run } = await setup([
      { paneKey: 'a:1', behavior: wakesAfterConfirm(true) },
      { paneKey: 'b:2', behavior: repliesAfter(30) },
    ]);

    const summary = await run();

    expect(port.sendsTo('a:1')).toBe(2);
    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'confirmed', pauseReason: null, wakeCount: 2 });
  });

  it('does not treat a confirmed agent that turns waiting as a wake: state alone never wakes it', async () => {
    const behavior: Behavior = ({ listCalls, received }) => {
      if (received.length === 0) return { state: 'working', message: null };
      return listCalls > 6 ? { state: 'waiting', message: null } : doneWithToken(received);
    };
    const { port, run } = await setup([
      { paneKey: 'a:1', behavior },
      { paneKey: 'b:2', behavior: repliesAfter(40) },
    ]);

    const summary = await run();

    expect(port.sendsTo('a:1')).toBe(1);
    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'confirmed', wakeCount: 0 });
  });

  for (const state of ['waiting', 'blocked']) {
    it(`sends nothing to an agent in state ${state} until it leaves that state`, async () => {
      const sendListings: number[] = [];
      const { port, run } = await setup([
        {
          paneKey: 'a:1',
          behavior: ({ listCalls, received }) =>
            received.length
              ? doneWithToken(received)
              : { state: listCalls === 1 || listCalls > 6 ? 'working' : state, message: null },
        },
      ]);
      port.onSend = () => {
        sendListings.push(port.listCalls);
      };

      const summary = await run();

      expect(sendListings).toHaveLength(1);
      expect(sendListings[0]).toBeGreaterThan(6);
      expect(summary.rows[0]?.pauseStatus).toBe('confirmed');
    });

    it(`reports an agent that stays in state ${state} as waiting-permission with its message pending`, async () => {
      const { port, run } = await setup([
        { paneKey: 'a:1', behavior: ({ listCalls }) => ({ state: listCalls === 1 ? 'working' : state, message: null }) },
      ]);
      const summary = await run();
      expect(port.sends).toHaveLength(0);
      expect(summary.rows[0]).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'waiting-permission', messagePending: true });
      expect(summary.exitCode).toBe(1);
    });
  }

  it('sends nothing when the agent turns waiting between the poll read and the pre-send read, and delivers later', async () => {
    const sendListings: number[] = [];
    const { port, run } = await setup([
      {
        paneKey: 'a:1',
        behavior: ({ listCalls, received }) =>
          received.length ? doneWithToken(received) : { state: listCalls === 2 ? 'waiting' : 'working', message: null },
      },
    ]);
    port.onSend = () => {
      sendListings.push(port.listCalls);
    };

    const summary = await run();

    expect(sendListings).toEqual([4]); // poll 1 = listing 1, failed pre-send = 2, poll 2 = 3, pre-send = 4
    expect(summary.rows[0]?.pauseStatus).toBe('confirmed');
  });

  describe('gone agents', () => {
    const goneCases: [string, Partial<FakeAgent>, string][] = [
      ['terminal missing', { terminalAt: () => 'missing' }, 'terminal-closed'],
      ['terminal orphaned', { terminalAt: () => 'orphaned' }, 'terminal-orphaned'],
      ['terminal not claude', { terminalAt: () => 'not-claude' }, 'agent-exited'],
      ['terminal not claude only at the pre-send read', { terminalAt: (l) => (l < 2 ? 'ok' : 'not-claude') }, 'agent-exited'],
      ['worktree ps row missing', { rowAt: (l) => l < 2 }, 'agent-missing'],
    ];
    for (const [name, overrides, reason] of goneCases) {
      it(`marks an agent gone (${reason}) when its ${name}, sends nothing, does not wait, and exits 1`, async () => {
        const { clock, port, run } = await setup([{ paneKey: 'a:1', behavior: working, ...overrides }]);

        const summary = await run();

        expect(summary.rows[0]).toMatchObject({ resumeStatus: 'gone', resumeReason: reason, pauseStatus: 'unconfirmed', pauseReason: 'still-working' });
        expect(port.sends).toHaveLength(0);
        expect(clock.slept).toBe(0);
        expect(summary.exitCode).toBe(1);
      });
    }

    it('keeps an agent gone when its terminal reappears and never messages it', async () => {
      const { port, run } = await setup([
        { paneKey: 'a:1', terminalAt: (l) => (l < 4 ? 'missing' : 'ok'), behavior: working },
        { paneKey: 'b:2', behavior: working },
      ]);
      const summary = await run(20_000);
      expect(summary.rows[0]).toMatchObject({ resumeStatus: 'gone', resumeReason: 'terminal-closed' });
      expect(port.sendsTo('a:1')).toBe(0);
    });

    it('records a swept agent that is gone on arrival as unconfirmed, sends it nothing and exits 1', async () => {
      const { port, run } = await setup([
        { paneKey: 'a:1', behavior: repliesWithToken() },
        { paneKey: 'b:2', rowAt: (l) => l >= 3, terminalAt: () => 'orphaned', behavior: working },
      ]);
      const summary = await run();
      expect(summary.rows[1]).toMatchObject({
        paneKey: 'b:2',
        resumeStatus: 'gone',
        resumeReason: 'terminal-orphaned',
        pauseStatus: 'unconfirmed',
        pauseReason: 'still-working',
        messagePending: true,
      });
      expect(port.sendsTo('b:2')).toBe(0);
      expect(summary.exitCode).toBe(1);
    });

    it('keeps a confirmed agent confirmed and the exit code 0 when its terminal disappears later', async () => {
      const { port, run } = await setup([
        { paneKey: 'a:1', terminalAt: (l) => (l >= 5 ? 'missing' : 'ok'), behavior: repliesWithToken() },
        { paneKey: 'b:2', behavior: repliesAfter(5) },
      ]);
      const summary = await run();
      expect(summary.rows[0]).toMatchObject({ pauseStatus: 'confirmed', resumeStatus: 'gone', resumeReason: 'terminal-closed' });
      expect(port.sendsTo('a:1')).toBe(1);
      expect(summary.exitCode).toBe(0);
    });

    it('shows the gone reason in the final table and ignores gone agents in the progress line', async () => {
      const progress: Progress[] = [];
      const port = new FakeOrca([
        { paneKey: 'a:1', hasTerminal: false, behavior: working },
        { paneKey: 'b:2', behavior: repliesWithToken() },
      ]);
      const summary = await pause(TIMEOUT, { port, clock: fakeClock(), store: createRecordStore(await tempStateDir()), onProgress: (p) => progress.push(p) });

      expect(progress.at(-1)).toMatchObject({ confirmed: 1, total: 1, reasons: {} });
      expect(renderTable(summary.rows)).toMatch(/tree-a:1\s+worker\s+unconfirmed\s+terminal-closed/);
    });
  });

  it('does not wait for a send-failed agent and does not retry it', async () => {
    const { clock, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    port.sendResult = () => ({ accepted: false, reason: 'terminal_handle_stale' });
    const summary = await run();
    expect(port.sendsTo('a:1')).toBe(1);
    expect(clock.slept).toBe(0);
    expect(summary).toMatchObject({ exitCode: 1 });
    expect(summary.rows[0]).toMatchObject({ pauseReason: 'send-failed', messagePending: true });
  });

  it('saves the record and exits 2 when the fresh read before a send fails, sending nothing', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    port.failListingsFrom = 2;
    const summary = await run();
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2 });
    expect(port.sends).toHaveLength(0);
    expect((await readRuns(dir))[0]?.agents[0]?.messagePending).toBe(true);
  });

  it('handles a late starter, a woken agent, a gone agent and a failed send in one run', async () => {
    const { port, run } = await setup([
      { paneKey: 'w:1', behavior: wakesAfterConfirm() },
      { paneKey: 'l:2', rowAt: (l) => l >= 4, behavior: repliesAfter(20) },
      { paneKey: 'g:3', terminalAt: () => 'orphaned', behavior: working },
      { paneKey: 'f:4', behavior: working },
    ]);
    port.sendResult = (handle) => (handle === port.handleOf('f:4') ? { accepted: false, reason: 'terminal_handle_stale' } : { accepted: true });

    const summary = await run();

    const by = Object.fromEntries(summary.rows.map((r) => [r.paneKey, r]));
    expect(by['w:1']).toMatchObject({ pauseReason: 're-woken' });
    expect(by['l:2']).toMatchObject({ pauseStatus: 'confirmed' });
    expect(by['g:3']).toMatchObject({ resumeStatus: 'gone', resumeReason: 'terminal-orphaned' });
    expect(by['f:4']).toMatchObject({ pauseReason: 'send-failed' });
    expect(port.sendsTo('g:3')).toBe(0);
    expect(port.sendsTo('f:4')).toBe(1);
    expect(summary.exitCode).toBe(1);
  });
});

describe('list retries', () => {
  it('recovers when a list call fails twice and works on the third attempt, waiting 1s between attempts', async () => {
    const { clock, port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    port.listFailures = 2;
    const summary = await run();
    expect(summary.exitCode).toBe(0);
    expect(clock.slept).toBe(2000 + 2000);
  });

  it('stops with exit 2 after the third failed attempt, 1s apart', async () => {
    const { clock, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    port.listError = new Error('orca-ide worktree ps failed: down');
    const summary = await run();
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2 });
    expect(summary.error).toContain('down');
    expect(clock.slept).toBe(2000);
  });

  it('retries a failing list in the middle of a run and saves the record when it still fails', async () => {
    const { dir, clock, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    port.onSend = () => {
      port.listError = new Error('orca-ide terminal list failed: down');
    };
    const summary = await run();
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2 });
    expect(clock.slept).toBe(2000 + 2000);
    expect(summary.run?.agents).toHaveLength(1);
    expect((await readRuns(dir))[0]?.agents[0]?.messagePending).toBe(false);
  });
});

describe('durability and interruption', () => {
  it('has the agent and its pending message on disk at every send', async () => {
    const { dir, port, run } = await setup([
      { paneKey: 'a:1', behavior: repliesWithToken() },
      { paneKey: 'b:2', behavior: repliesWithToken() },
    ]);
    const seen: boolean[][] = [];
    port.onSend = async () => {
      const [record] = await readRuns(dir);
      seen.push((record?.agents ?? []).map((a) => a.messagePending));
    };
    await run();
    expect(seen).toEqual([[true, true], [false, true]]);
  });

  it('saves the record and exits 130 when interrupted while waiting', async () => {
    const { dir, clock, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    const abort = new AbortController();
    clock.onSleep = () => abort.abort('SIGTERM');
    const summary = await run(TIMEOUT, undefined, abort.signal);
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 130, error: 'interrupted by SIGTERM' });
    const [record] = await readRuns(dir);
    expect(record?.agents[0]).toMatchObject({ paneKey: 'a:1', messagePending: false });
    expect(port.sends).toHaveLength(1);
  });

  it('exits 130 when the signal arrives during the last send, even though every agent is settled', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    const abort = new AbortController();
    port.sendResult = () => ({ accepted: false, reason: 'terminal_handle_stale' });
    port.onSend = () => abort.abort('SIGTERM');
    const summary = await run(TIMEOUT, undefined, abort.signal);
    expect(summary.exitCode).toBe(130);
    expect((await readRuns(dir))[0]?.agents[0]?.pauseReason).toBe('send-failed');
  });

  it('lets a send in flight finish and be recorded, then stops before the next send', async () => {
    const { dir, port, run } = await setup([
      { paneKey: 'a:1', behavior: working },
      { paneKey: 'b:2', behavior: working },
    ]);
    const abort = new AbortController();
    port.onSend = () => abort.abort('SIGHUP');
    const summary = await run(TIMEOUT, undefined, abort.signal);
    expect(summary.exitCode).toBe(130);
    expect(port.sends).toHaveLength(1);
    const [record] = await readRuns(dir);
    expect(record?.agents.map((a) => a.messagePending)).toEqual([false, true]);
  });

  it('stops during a retry wait and still saves an existing record', async () => {
    const { dir, clock, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    const abort = new AbortController();
    port.onSend = () => {
      port.listError = new Error('down');
      clock.onSleep = () => abort.abort('SIGINT');
    };
    const summary = await run(TIMEOUT, undefined, abort.signal);
    expect(summary.exitCode).toBe(130);
    expect(await readRuns(dir)).toHaveLength(1);
  });

  it('creates no record when the signal arrives during the first listing', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    const abort = new AbortController();
    const list = port.listAgents.bind(port);
    port.listAgents = async () => {
      abort.abort('SIGTERM');
      return list();
    };
    const summary = await run(TIMEOUT, undefined, abort.signal);
    expect(summary).toMatchObject({ exitCode: 130, run: null });
    expect(port.sends).toHaveLength(0);
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('exits 130 without creating a record or calling Orca when already interrupted', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    const summary = await run(TIMEOUT, undefined, AbortSignal.abort('SIGTERM'));
    expect(summary.exitCode).toBe(130);
    expect(port.listCalls).toBe(0);
    await expect(readdir(dir)).rejects.toThrow();
  });
});

describe('open run recovery', () => {
  it('extends the newest open run and leaves the other open runs alone', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    const store = createRecordStore(dir);
    const base: Run = { runId: 'r-old', token: 'cafebabe', startedAt: '2026-01-01T00:00:00.000Z', status: 'open', agents: [] };
    await store.save(base);
    await store.save({ ...base, runId: 'r-new', startedAt: '2026-02-01T00:00:00.000Z' });
    const summary = await run();
    expect(summary.exitCode).toBe(0);
    expect(summary.run?.runId).toBe('r-new');
    expect(summary.run?.token).toBe('cafebabe');
    expect(port.sends).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, 'r-old.json'), 'utf8')).agents).toEqual([]);
  });

  it('exits 2 naming the file when a record is unreadable', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.json'), '{');
    const summary = await run();
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2 });
    expect(summary.error).toMatch(/unreadable record .*broken\.json/);
    expect(port.listCalls).toBe(0);
  });
});

describe('pause reasons', () => {
  const REST =
    ' Finish the step you are on now. Do not start a new step and do not commit. Then end your turn with a short note: where you stopped, and your next step. The last line of your reply must be exactly: ORCA-PAUSED abcd1234. If a background task or notification wakes you before that, do not act on it: reply with one short line, and end that reply with the same last line. After that, do nothing until you get a message that starts with [orca-broadcast] CONTINUE.';
  const COORDINATOR_SENTENCE = ' Do not dispatch new workers or tasks.';
  const cases: [Preset | undefined, string][] = [
    ['network', 'The user is leaving and the network will drop.'],
    ['away', 'The user is stepping away for a while.'],
    ['end-of-day', 'The user is stopping work for the day.'],
    ['limit', 'The user is close to a usage or rate limit.'],
    [undefined, 'The user asked all agents to pause.'],
  ];

  for (const [reason, sentence] of cases) {
    it(`sends the exact ${reason ?? 'neutral'} pause sentence to a worker and a coordinator, and records the reason`, async () => {
      const dir = await tempStateDir();
      const port = new FakeOrca([
        { paneKey: 'w:1', behavior: repliesWithToken() },
        { paneKey: 'c:2', behavior: repliesWithToken() },
      ]);
      port.coordinatorsAt = () => ['c:2'];

      await pause(TIMEOUT, { port, clock: fakeClock(), store: createRecordStore(dir), newToken: () => 'abcd1234', reason });

      const text = (key: string) => port.sends.find((s) => s.handle === port.handleOf(key))?.text;
      expect(text('w:1')).toBe(`[orca-broadcast] ${sentence}${REST}`);
      expect(text('c:2')).toBe(`[orca-broadcast] ${sentence}${REST}${COORDINATOR_SENTENCE}`);
      const [record] = await readRuns(dir);
      expect(record && 'reason' in record).toBe(reason !== undefined);
      expect(record?.reason).toBe(reason);
    });
  }
});
