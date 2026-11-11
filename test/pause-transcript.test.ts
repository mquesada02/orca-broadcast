import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Run, TranscriptIdentity, TranscriptMark } from '../src/types.js';
import { agentRecord, fakeClock, seedOpenRun, working, type Behavior, type FakeAgent, type FakeOrca } from './helpers/fake-orca.js';
import { scanOf } from './helpers/roster.js';
import { runCli, type RunCliOptions } from './helpers/run-cli.js';

const TOKEN = 'abcd1234';
const PAUSE = `ORCA-PAUSED ${TOKEN}`;
const newToken = () => TOKEN;
const PANE = 'a:1';
const SESSION = 's1';

const identity: TranscriptIdentity = { sessionId: SESSION, cwd: '/work/tree-a:1', configDir: '/cfg', pid: 10, startTime: 5 };

/** Working before the message; after it, done with a reply that has no pause line (a wake-up turn hid it). */
const wokenAfterSend: Behavior = ({ received }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'done', message: 'Back at work.' });
const waitingAfterSend: Behavior = ({ received }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'waiting', message: null });

/** The agent has a session in the scan; `onSend(port, n)` edits its transcript at the n-th send, right after the offset was taken (the fake takes the offset before `send`). */
const session = (onSend: (port: FakeOrca, n: number) => void = () => {}, withIdentity = true) => (port: FakeOrca): void => {
  port.scanAt = () => scanOf({ sessionId: SESSION, paneKey: PANE, cwd: identity.cwd, startTime: 5, ...(withIdentity ? { transcript: identity } : {}) });
  port.transcript(SESSION);
  let sends = 0;
  port.onSend = () => {
    sends += 1;
    onSend(port, sends);
  };
};

const pauseRun = (behavior: Behavior, opts: RunCliOptions = {}, agents: FakeAgent[] = [{ paneKey: PANE, behavior }]) => runCli(['pause', '--yes', '--timeout', '10s'], agents, { newToken, ...opts });

async function runs(dir: string): Promise<Run[]> {
  const folder = join(dir, 'orca-broadcast', 'pauses');
  const names = (await readdir(folder).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(folder, n), 'utf8')) as Run));
}
const agentOf = async (dir: string, paneKey = PANE) => ((await runs(dir))[0] as Run).agents.find((a) => a.paneKey === paneKey) as Run['agents'][number];

/** A clock whose n-th sleep runs `steps[n]` before the next poll. */
const scriptedClock = (steps: Record<number, () => void>) => {
  const clock = fakeClock();
  let sleeps = 0;
  clock.onSleep = () => {
    sleeps += 1;
    steps[sleeps]?.();
  };
  return clock;
};

describe('pause: the transcript proof', () => {
  it('confirms an agent whose pause reply was followed by a wake-up turn', async () => {
    const { code, dir, port } = await pauseRun(wokenAfterSend, { configure: session((p) => p.transcript(SESSION).reply(`Stopped.\n${PAUSE}`).reply('Back at work.')) });
    expect(code).toBe(0);
    expect(await agentOf(dir)).toMatchObject({ pauseStatus: 'confirmed', pauseReason: null });
    expect(port.scanCalls).toBe(2); // the start and the end roster save, as without a transcript
  });

  it('does not confirm an agent whose pause line is only in a mid-turn entry', async () => {
    const { code, dir } = await pauseRun(wokenAfterSend, { configure: session((p) => p.transcript(SESSION).ignored(PAUSE).reply('Back at work.')) });
    expect(code).toBe(1);
    expect(await agentOf(dir)).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'done-no-token' });
  });

  it('does not count a reply written before the send', async () => {
    const { code } = await pauseRun(wokenAfterSend, { configure: (port) => { session()(port); port.transcript(SESSION).reply(PAUSE); } });
    expect(code).toBe(1);
  });

  it('keeps a confirmation after the transcript is removed, and reads no more', async () => {
    const other: FakeAgent = { paneKey: 'b:2', behavior: working };
    let reads = 0;
    let port: FakeOrca | undefined;
    const clock = scriptedClock({
      2: () => {
        reads = (port as FakeOrca).transcriptReads.length;
        (port as FakeOrca).transcript(SESSION).remove();
      },
    });
    const { dir } = await pauseRun(wokenAfterSend, { clock, configure: (p) => { port = p; session((q) => q.transcript(SESSION).reply(PAUSE).reply('Back at work.'))(p); } }, [{ paneKey: PANE, behavior: wokenAfterSend }, other]);
    expect(await agentOf(dir)).toMatchObject({ pauseStatus: 'confirmed' });
    expect((port as FakeOrca).transcriptReads).toHaveLength(reads);
  });

  it('takes the offset and file id just before the send, with no transcript text in the run', async () => {
    const { dir, out } = await pauseRun(wokenAfterSend, { configure: session((p) => p.transcript(SESSION).reply(`Secret words.\n${PAUSE}`)) });
    expect((await agentOf(dir)).pauseTranscript).toEqual({ identity, position: 0, fileId: 'gen-1' });
    const text = JSON.stringify(await runs(dir));
    expect(text).not.toContain('ORCA-PAUSED');
    expect(text).not.toContain('Secret words');
    expect(out).not.toContain('Secret words');
  });

  it('shows the offset in the --json line, never transcript text', async () => {
    const { out } = await runCli(['pause', '--yes', '--timeout', '10s', '--json'], [{ paneKey: PANE, behavior: wokenAfterSend }], { newToken, configure: session((p) => p.transcript(SESSION).reply(`Secret words.\n${PAUSE}`)) });
    const line = JSON.parse(out.trim().split('\n').at(-1) as string) as { run: Run };
    expect(line.run.agents[0]?.pauseTranscript).toEqual({ identity, position: 0, fileId: 'gen-1' });
    expect(out).not.toContain('Secret words');
  });

  it('keeps today\'s check when the agent has no transcript or no identity in the scan', async () => {
    const pausesInOrca: Behavior = ({ received }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'done', message: `Done.\n${PAUSE}` });
    for (const configure of [undefined, session(() => {}, false), (port: FakeOrca) => { port.scanAt = () => scanOf(); }]) {
      const { code, dir } = await pauseRun(pausesInOrca, { configure });
      expect(code).toBe(0);
      expect((await agentOf(dir)).pauseTranscript).toBeUndefined();
    }
    const { code, dir } = await pauseRun(wokenAfterSend, { configure: session((p) => p.transcript(SESSION).reply(PAUSE), false) });
    expect(code).toBe(1);
    expect((await agentOf(dir)).pauseTranscript).toBeUndefined();
  });

  it.each<[string, (port: FakeOrca) => void, (port: FakeOrca) => void]>([
    ['the file is removed', () => {}, (p) => p.transcript(SESSION).reply(PAUSE).remove()],
    ['the file shrinks', (p) => p.transcript(SESSION).reply('one').reply('two'), (p) => p.transcript(SESSION).shrink(2).reply(PAUSE)],
    ['the file is replaced', () => {}, (p) => p.transcript(SESSION).replace().reply(PAUSE)],
  ])('falls back to today\'s check when %s', async (_name, before, onSend) => {
    const { code, dir } = await pauseRun(wokenAfterSend, { configure: (port) => { session((p) => onSend(p))(port); before(port); } });
    expect(code).toBe(1);
    expect((await agentOf(dir)).pauseStatus).toBe('unconfirmed');
  });

  it('falls back when the port reports the session as changed, and then reads no more in the run', async () => {
    const { code, port } = await pauseRun(wokenAfterSend, {
      configure: (port) => {
        session((p) => p.transcript(SESSION).reply(PAUSE))(port);
        const read = port.readTranscript.bind(port);
        port.readTranscript = async (id, position, fileId, texts) => (fileId === null ? read(id, position, fileId, texts) : (await read(id, position, fileId, texts), { kind: 'missing' as const }));
      },
    });
    expect(code).toBe(1);
    expect(port.transcriptReads.filter((r) => r.fileId !== null)).toHaveLength(1);
  });

  it('confirms an agent on a permission prompt only when a reply has the pause line as its last line', async () => {
    const confirmed = await pauseRun(waitingAfterSend, { configure: session((p) => p.transcript(SESSION).reply(`Need ok.\n${PAUSE}`)) });
    expect(confirmed.code).toBe(0);
    const open = await pauseRun(waitingAfterSend, { configure: session((p) => p.transcript(SESSION).reply(`Need ok. ${PAUSE} is below.\nWaiting.`)) });
    expect(open.code).toBe(1);
    expect(await agentOf(open.dir)).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'waiting-permission' });
  });

  it('sends no message and takes no offset for an agent that is on a permission prompt when its send is due', async () => {
    const waiting = await runCli(['pause', '--yes', '--timeout', '10s'], [{ paneKey: PANE, behavior: () => ({ state: 'waiting', message: null }) }], {
      newToken,
      seed: (store) => seedOpenRun(store, [agentRecord(PANE, { pauseStatus: 'unconfirmed', pauseReason: 'waiting-permission', messagePending: true, confirmedAt: null })], { token: TOKEN }),
      configure: (p) => { session()(p); p.transcript(SESSION).reply(PAUSE); },
    });
    expect(waiting.port.sends).toEqual([]);
    expect(await agentOf(waiting.dir)).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'waiting-permission' });
    expect((await agentOf(waiting.dir)).pauseTranscript).toBeUndefined();
  });

  it('uses today\'s check for an older run with no offset', async () => {
    const seed = (store: Parameters<NonNullable<RunCliOptions['seed']>>[0]) => seedOpenRun(store, [agentRecord(PANE, { pauseStatus: 'unconfirmed', pauseReason: 'done-no-token', pauseBaseline: 'Earlier.', confirmedAt: null })], { token: TOKEN });
    const inOrca: Behavior = () => ({ state: 'done', message: `Done.\n${PAUSE}` });
    const confirmed = await runCli(['pause', '--yes', '--timeout', '10s'], [{ paneKey: PANE, behavior: inOrca }], { newToken, seed, configure: (p) => { session()(p); p.transcript(SESSION); } });
    expect(confirmed.code).toBe(0);
    const stale: Behavior = () => ({ state: 'done', message: 'Back at work.' });
    const open = await runCli(['pause', '--yes', '--timeout', '10s'], [{ paneKey: PANE, behavior: stale }], { newToken, seed, configure: (p) => { session()(p); p.transcript(SESSION).reply(PAUSE); } });
    expect(open.code).toBe(1);
    expect(open.port.transcriptReads.filter((r) => r.fileId !== null)).toEqual([]);
  });

  it('keeps no offset when the send is refused, and the transcript does not confirm the agent', async () => {
    const { code, dir } = await pauseRun(wokenAfterSend, {
      configure: (port) => { session((p) => p.transcript(SESSION).reply(PAUSE))(port); port.sendResult = () => ({ accepted: false, reason: 'refused' }); },
    });
    expect(code).toBe(1);
    expect(await agentOf(dir)).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 'send-failed' });
    expect((await agentOf(dir)).pauseTranscript).toBeUndefined();
  });

  it('keeps no offset when the send throws', async () => {
    const { code, dir } = await pauseRun(wokenAfterSend, {
      configure: (port) => {
        session()(port);
        port.onSend = () => {
          throw new Error('boom');
        };
      },
    });
    expect(code).toBe(2);
    expect((await agentOf(dir)).pauseTranscript).toBeUndefined();
  });

  it('gives an agent that the sweep adds after the start scan no offset', async () => {
    const late: FakeAgent = { paneKey: 'b:2', behavior: working, rowAt: (listing) => listing >= 3 };
    const { dir } = await pauseRun(wokenAfterSend, { configure: (p) => { session()(p); p.transcript('s2').reply(PAUSE); } }, [{ paneKey: PANE, behavior: wokenAfterSend }, late]);
    const swept = await agentOf(dir, 'b:2');
    expect(swept.pauseTranscript).toBeUndefined();
    expect(swept.pauseStatus).toBe('unconfirmed');
  });

  it('reads no transcript while it plans the confirmation', async () => {
    let seen = -1;
    let port: FakeOrca | undefined;
    await runCli(['pause', '--timeout', '10s'], [{ paneKey: PANE, behavior: wokenAfterSend }], {
      newToken,
      ask: [() => { seen = (port as FakeOrca).transcriptReads.length; return 'y'; }],
      configure: (p) => { port = p; session((q) => q.transcript(SESSION).reply(PAUSE))(p); },
    });
    expect(seen).toBe(0);
  });

  describe('a woken agent', () => {
    /** Orca shows `orca.reply` once the first message arrived; the test changes it between polls. */
    const withOther = (behavior: Behavior): FakeAgent[] => [{ paneKey: PANE, behavior }, { paneKey: 'b:2', behavior: working }];
    const shows = (orca: { reply: string }): Behavior => ({ received }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'done', message: orca.reply });

    it.each([['by the transcript', 'Back at work.'], ['by Orca\'s last reply', `Stopped.\n${PAUSE}`]])('is not confirmed again by the first pause reply, in the same poll or later (first confirmed %s)', async (_name, first) => {
      const orca = { reply: first };
      const clock = scriptedClock({ 2: () => { orca.reply = 'Woke.'; } });
      const { code, dir, port } = await pauseRun(shows(orca), { clock, configure: session((p, n) => { if (n === 1) p.transcript(SESSION).reply(PAUSE).reply('Back at work.'); }) }, withOther(shows(orca)));
      expect(code).toBe(1); // confirmed by the transcript, woken, re-opened and sent again, with no new pause reply
      expect(port.sendsTo(PANE)).toBe(2);
      expect(await agentOf(dir)).toMatchObject({ pauseStatus: 'unconfirmed', wakeCount: 1 });
    });

    it('is not confirmed by a pause reply that was read before the re-open', async () => {
      const orca = { reply: 'Back at work.' };
      const clock = scriptedClock({
        2: () => (port as FakeOrca).transcript(SESSION).reply(PAUSE), // read after the first confirmation: it is not read again
        3: () => {
          orca.reply = 'Woke.';
          (port as FakeOrca).transcript(SESSION).reply('Woke.');
        },
      });
      let port: FakeOrca | undefined;
      const { code, dir } = await pauseRun(shows(orca), { clock, configure: (p) => { port = p; session((q, n) => { if (n === 1) q.transcript(SESSION).reply(PAUSE).reply('Back at work.'); })(p); } }, withOther(shows(orca)));
      expect(code).toBe(1);
      expect(await agentOf(dir)).toMatchObject({ pauseStatus: 'unconfirmed' });
    });

    it('is confirmed by a new pause reply, with a new offset', async () => {
      const orca = { reply: 'Back at work.' };
      const clock = scriptedClock({ 2: () => { orca.reply = 'Woke.'; } });
      const { dir } = await pauseRun(shows(orca), {
        clock,
        configure: session((p, n) => {
          if (n === 1) p.transcript(SESSION).reply(PAUSE).reply('Back at work.');
          else p.transcript(SESSION).reply(`Again.\n${PAUSE}`);
        }),
      }, withOther(shows(orca)));
      const agent = await agentOf(dir);
      expect(agent.pauseStatus).toBe('confirmed');
      expect((agent.pauseTranscript as TranscriptMark).position).toBeGreaterThan(0);
    });

    it('stays unproven by the transcript at a second wake with no re-send (re-woken)', async () => {
      const orca = { reply: `Stopped.\n${PAUSE}` };
      const clock = scriptedClock({
        2: () => { orca.reply = 'Woke 1.'; },
        3: () => { orca.reply = `Paused again.\n${PAUSE}`; },
        4: () => { orca.reply = 'Woke 2.'; },
      });
      const { code, dir, port } = await pauseRun(shows(orca), { clock, configure: session((p) => p.transcript(SESSION).reply(PAUSE)) }, withOther(shows(orca)));
      expect(code).toBe(1);
      expect(port.sendsTo(PANE)).toBe(2);
      const agent = await agentOf(dir);
      expect(agent).toMatchObject({ pauseStatus: 'unconfirmed', pauseReason: 're-woken' });
      expect(agent.pauseTranscript).toBeUndefined();
    });
  });
});
