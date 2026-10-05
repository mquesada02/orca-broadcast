import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pause, pauseMessage } from '../src/pause.js';
import { createRecordStore } from '../src/store.js';
import type { Run } from '../src/types.js';
import { type Behavior, type FakeAgent, fakeClock, FakeOrca, repliesWithToken, tempStateDir, tokenOf, working } from './helpers/fake-orca.js';

const TIMEOUT = 60_000;

async function setup(agents: FakeAgent[]) {
  const dir = await tempStateDir();
  const port = new FakeOrca(agents);
  const clock = fakeClock();
  const run = (timeoutMs = TIMEOUT, newToken?: () => string) =>
    pause(timeoutMs, { port, clock, store: createRecordStore(dir), newToken });
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

  it('ends as soon as every agent is confirmed, reading one listing per poll', async () => {
    const { clock, port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await run();
    expect(port.listCalls).toBe(2);
    expect(clock.slept).toBe(2000);
  });

  it('runs no poll at the deadline: a 5s timeout polls at 0s, 2s and 4s', async () => {
    const { clock, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    await run(5000);
    expect(port.listCalls).toBe(3);
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
      '[orca-pause] The user is leaving and the network will drop. Finish the step you are on now. Do not start a new step and do not commit. Then end your turn with a short note: where you stopped, and your next step. The last line of your reply must be exactly: ORCA-PAUSED abcd1234. After that, do nothing until you get a message that starts with [orca-pause] CONTINUE.',
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

  it('does not accept a message while the agent is still working', async () => {
    const behavior: Behavior = ({ received }) =>
      received.length ? { state: 'working', message: `note\nORCA-PAUSED ${tokenOf(received[0] as string)}` } : { state: 'working', message: null };
    const { run } = await setup([{ paneKey: 'a:1', behavior }]);
    expect((await run(10_000)).rows[0]).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'still-working' });
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

  it('records a working agent with no terminal as send-failed and sends nothing to it', async () => {
    const { port, run } = await setup([{ paneKey: 'a:1', hasTerminal: false, behavior: working }]);
    const summary = await run();
    expect(summary.exitCode).toBe(1);
    expect(summary.rows[0]).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'send-failed', lastHandle: null });
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

  it('never messages a send-failed agent even when its terminal appears in a later poll', async () => {
    const { port, run } = await setup([
      { paneKey: 'a:1', hasTerminal: false, behavior: working },
      { paneKey: 'b:2', behavior: working },
    ]);
    port.onSend = () => {
      (port.agents[0] as { hasTerminal?: boolean }).hasTerminal = true;
    };

    const summary = await run();

    expect(port.sendsTo('a:1')).toBe(0);
    expect(summary.rows[0]).toMatchObject({ pauseReason: 'send-failed' });
    expect(summary.exitCode).toBe(1);
  });

  it('waits the full timeout for an agent whose worktree row disappears', async () => {
    const { clock, port, run } = await setup([{ paneKey: 'a:1', behavior: working }]);
    port.onSend = () => {
      port.agents = [];
    };

    const summary = await run();

    expect(summary.exitCode).toBe(1);
    expect(summary.rows[0]?.pauseStatus).toBe('unconfirmed');
    expect(clock.slept).toBeGreaterThanOrEqual(TIMEOUT);
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

describe('an open run already exists', () => {
  const openRun: Run = { runId: 'old-run', token: 'cafebabe', startedAt: '2026-01-01T00:00:00.000Z', status: 'open', agents: [] };

  it('exits 2 before any Orca call when the pointer names an open run', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    const store = createRecordStore(dir);
    await store.save(openRun);
    await store.setCurrent('old-run');

    const summary = await run();

    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2 });
    expect(summary.error).toContain(dir);
    expect(port.listCalls).toBe(0);
    expect(port.sends).toHaveLength(0);
  });

  it('exits 2 when the pointer is missing but a run file is open', async () => {
    const { dir, port, run } = await setup([{ paneKey: 'a:1', behavior: repliesWithToken() }]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'old-run.json'), JSON.stringify(openRun));

    const summary = await run();

    expect(summary.exitCode).toBe(2);
    expect(port.sends).toHaveLength(0);
  });

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
