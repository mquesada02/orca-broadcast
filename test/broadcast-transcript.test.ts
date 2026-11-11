import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordStore } from '../src/store.js';
import type { BroadcastRecord, TranscriptIdentity, TranscriptMark } from '../src/types.js';
import { broadcastTarget, openBroadcastRecord, type Behavior, type FakeOrca } from './helpers/fake-orca.js';
import { scanOf } from './helpers/roster.js';
import { runCli, type RunCliOptions } from './helpers/run-cli.js';

const TOKEN = 'abcd1234';
const ACK = `ORCA-ACK ${TOKEN}`;
const newToken = () => TOKEN;
const PANE = 'a:1';
const SESSION = 's1';

const identity: TranscriptIdentity = { sessionId: SESSION, cwd: '/work/tree-a:1', configDir: '/cfg', pid: 10, startTime: 5 };
const MARK: TranscriptMark = { identity, position: 0, fileId: 'gen-1' };

/** Working before the message; after it, done with a later reply that has no ack line (a wake-up turn hid the ack). */
const wokenAfterSend: Behavior = ({ received }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'done', message: 'Back at work.' });
const waitingAfterSend: Behavior = ({ received }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'waiting', message: null });

const sessionScan = (withIdentity: boolean) => scanOf({ sessionId: SESSION, paneKey: PANE, cwd: identity.cwd, startTime: 5, ...(withIdentity ? { transcript: identity } : {}) });

/** The agent has a session in the scan; `onSend` edits its transcript right after the offset was taken (the fake takes the offset before `send`). */
const session = (onSend: (port: FakeOrca) => void = () => {}, withIdentity = true) => (port: FakeOrca): void => {
  port.scanAt = () => sessionScan(withIdentity);
  port.transcript(SESSION);
  port.onSend = () => onSend(port);
};

const send = (behavior: Behavior, opts: RunCliOptions = {}) => runCli(['broadcast', 'go', '--yes', '--timeout', '10s'], [{ paneKey: PANE, behavior }], { newToken, ...opts });
const rerun = (behavior: Behavior, opts: RunCliOptions = {}) => runCli(['broadcast', '--yes', '--timeout', '10s'], [{ paneKey: PANE, behavior }], { newToken, ...opts });

async function records(dir: string): Promise<BroadcastRecord[]> {
  const folder = join(dir, 'orca-broadcast', 'broadcasts');
  const names = await readdir(folder).catch(() => [] as string[]);
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(folder, n), 'utf8')) as BroadcastRecord));
}
const only = async (dir: string) => ((await records(dir))[0] as BroadcastRecord).targets[0] as BroadcastRecord['targets'][number];

const seed = (target: ReturnType<typeof broadcastTarget>) => async (store: RecordStore) => {
  const record = openBroadcastRecord([target]);
  await store.saveBroadcast(record);
  await store.setCurrent('broadcast', record.id);
};

describe('broadcast: the transcript proof', () => {
  it('acks an agent whose ack reply was followed by a wake-up turn', async () => {
    const { code, port, dir } = await send(wokenAfterSend, { configure: session((p) => p.transcript(SESSION).reply(`Done.\n${ACK}`).reply('Back at work.')) });
    expect(code).toBe(0);
    expect((await only(dir)).status).toBe('acked');
    expect(port.scanCalls).toBe(2); // the start and the end roster save, as without a transcript
  });

  it('does not ack an agent whose token line is only in a mid-turn entry', async () => {
    const { code, dir } = await send(wokenAfterSend, { configure: session((p) => p.transcript(SESSION).ignored(ACK).reply('Back at work.')) });
    expect(code).toBe(1);
    expect(await only(dir)).toMatchObject({ status: 'pending', reason: 'no-ack' });
  });

  it('does not count a reply written before the send', async () => {
    const { code } = await send(wokenAfterSend, { configure: (port) => { session()(port); port.transcript(SESSION).reply(ACK); } });
    expect(code).toBe(1);
  });

  it('takes the offset and file id just before the send, with no transcript text in the record', async () => {
    const { dir } = await send(wokenAfterSend, { configure: session((p) => p.transcript(SESSION).reply(`Secret words.\n${ACK}`)) });
    const target = await only(dir);
    expect(target.transcript).toEqual({ identity, position: 0, fileId: 'gen-1' });
    const text = JSON.stringify(await records(dir));
    expect(text).not.toContain('ORCA-ACK');
    expect(text).not.toContain('Secret words');
  });

  it('keeps today\'s check when the agent has no transcript, or no identity in the scan', async () => {
    const acksInOrca: Behavior = ({ received }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'done', message: `Done.\n${ACK}` });
    for (const configure of [undefined, session(() => {}, false), (port: FakeOrca) => { port.scanAt = () => scanOf(); }]) {
      const { code, dir } = await send(acksInOrca, { configure });
      expect(code).toBe(0);
      expect((await only(dir)).transcript).toBeUndefined();
    }
    const { code, dir } = await send(wokenAfterSend, { configure: session((p) => p.transcript(SESSION).reply(ACK), false) });
    expect(code).toBe(1);
    expect((await only(dir)).transcript).toBeUndefined();
  });

  it.each<[string, (port: FakeOrca) => void, (port: FakeOrca) => void]>([
    ['the file is removed', () => {}, (p) => p.transcript(SESSION).reply(ACK).remove()],
    ['the file shrinks', (p) => p.transcript(SESSION).reply('one').reply('two'), (p) => p.transcript(SESSION).shrink(2).reply(ACK)],
    ['the file is replaced', () => {}, (p) => p.transcript(SESSION).replace().reply(ACK)],
  ])('falls back to today\'s check when %s', async (_name, before, onSend) => {
    const { code, dir } = await send(wokenAfterSend, { configure: (port) => { session(onSend)(port); before(port); } });
    expect(code).toBe(1);
    expect((await only(dir)).status).toBe('pending');
  });

  it('still acks from Orca\'s last reply when the transcript is missing, and keeps the stored mark for a later run', async () => {
    const acksInOrca: Behavior = () => ({ state: 'done', message: `Done.\n${ACK}` });
    const missing = await rerun(acksInOrca, { seed: seed(broadcastTarget(PANE, { baseline: 'Earlier.', transcript: MARK })), configure: (port) => port.transcript(SESSION).remove() });
    expect(missing.code).toBe(0);
    const stale = await rerun(wokenAfterSend, { seed: seed(broadcastTarget(PANE, { baseline: 'Earlier.', transcript: MARK })), configure: (port) => port.transcript(SESSION).remove() });
    expect(stale.code).toBe(1);
    expect((await only(stale.dir)).transcript).toEqual(MARK);
    const readable = await rerun(wokenAfterSend, { seed: seed(broadcastTarget(PANE, { baseline: 'Earlier.', transcript: MARK })), configure: (port) => port.transcript(SESSION).reply(ACK) });
    expect(readable.code).toBe(0);
  });

  it('does not prove from the transcript when the scan has no entry and the target has no stored mark', async () => {
    const { code } = await send(wokenAfterSend, { configure: (port) => { port.transcript(SESSION).reply(ACK); port.onSend = () => { port.transcript(SESSION).reply(ACK); }; } });
    expect(code).toBe(1);
  });

  it('falls back when the port reports the session as changed, and then reads no more in the run', async () => {
    const { code, port } = await send(wokenAfterSend, {
      configure: (port) => {
        session((p) => p.transcript(SESSION).reply(ACK))(port);
        const read = port.readTranscript.bind(port);
        port.readTranscript = async (id, position, fileId, texts) => (fileId === null ? read(id, position, fileId, texts) : (await read(id, position, fileId, texts), { kind: 'missing' as const }));
      },
    });
    expect(code).toBe(1);
    expect(port.transcriptReads.filter((r) => r.fileId !== null)).toHaveLength(1);
  });

  it('acks a target on a permission prompt only when a reply has the token line as its last line', async () => {
    const acked = await send(waitingAfterSend, { configure: session((p) => p.transcript(SESSION).reply(`Need ok.\n${ACK}`)) });
    expect(acked.code).toBe(0);
    const open = await send(waitingAfterSend, { configure: session((p) => p.transcript(SESSION).reply(`Need ok. ${ACK} is below.\nWaiting.`)) });
    expect(open.code).toBe(1);
    expect(await only(open.dir)).toMatchObject({ status: 'pending', reason: 'waiting-permission' });
  });

  it('keeps the first offset when a re-run sends again', async () => {
    const first: TranscriptMark = { identity: { ...identity, pid: 99, startTime: 1 }, position: 7, fileId: 'gen-0' }; // differs from every fresh mark
    const { dir } = await rerun(wokenAfterSend, {
      seed: seed(broadcastTarget(PANE, { messagePending: true, reason: 'send-failed', transcript: first })),
      configure: (port) => { session()(port); port.transcript(SESSION).reply('earlier'); },
    });
    expect((await only(dir)).transcript).toEqual(first);
  });

  it('acks a target whose send looked failed but whose transcript has the token reply', async () => {
    const { code, port, dir } = await rerun(wokenAfterSend, {
      seed: seed(broadcastTarget(PANE, { messagePending: true, reason: 'send-failed', transcript: MARK })),
      configure: (p) => p.transcript(SESSION).reply(`Done.\n${ACK}`),
    });
    expect(code).toBe(0);
    expect(port.sends).toEqual([]);
    expect((await only(dir)).status).toBe('acked');
  });

  it('marks an older record that is sent now, and leaves one that is not sent alone', async () => {
    const sent = await rerun(wokenAfterSend, { seed: seed(broadcastTarget(PANE, { messagePending: true, reason: null })), configure: session() });
    expect((await only(sent.dir)).transcript).toEqual({ identity, position: 0, fileId: 'gen-1' });
    const waiting = await rerun(wokenAfterSend, { seed: seed(broadcastTarget(PANE, { baseline: 'Earlier.' })), configure: (port) => { session()(port); port.transcript(SESSION).reply(ACK); } });
    expect(waiting.code).toBe(1);
    expect(waiting.port.transcriptReads).toEqual([]);
  });

  it('acks a re-run from the stored identity, also when the new scan has no entry', async () => {
    const { code } = await rerun(wokenAfterSend, {
      seed: seed(broadcastTarget(PANE, { baseline: 'Earlier.', transcript: MARK })),
      configure: (port) => { port.transcript(SESSION).reply(`Done.\n${ACK}`).reply('Back at work.'); },
    });
    expect(code).toBe(0);
  });

  it('keeps an ack after the transcript is removed', async () => {
    const { code, dir } = await runCli(['broadcast', '--yes', '--timeout', '10s'], [{ paneKey: PANE, behavior: wokenAfterSend }, { paneKey: 'b:1', behavior: wokenAfterSend }], {
      newToken,
      seed: async (store) => {
        const record = openBroadcastRecord([broadcastTarget(PANE, { status: 'acked', reason: null, transcript: MARK }), broadcastTarget('b:1', { baseline: 'Earlier.' })]);
        await store.saveBroadcast(record);
        await store.setCurrent('broadcast', record.id);
      },
      configure: (port) => port.transcript(SESSION).remove(),
    });
    expect(code).toBe(1);
    const [acked, pending] = ((await records(dir))[0] as BroadcastRecord).targets;
    expect([acked?.status, pending?.status]).toEqual(['acked', 'pending']);
  });
});
