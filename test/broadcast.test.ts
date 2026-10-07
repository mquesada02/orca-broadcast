import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { broadcastMessage } from '../src/broadcast.js';
import type { RecordStore } from '../src/store.js';
import type { BroadcastRecord, BroadcastTarget } from '../src/types.js';
import { agentRecord, fakeClock, seedOpenRun, working, type Behavior, type FakeAgent } from './helpers/fake-orca.js';
import { CTRL_C, runCli, type RunCliOptions } from './helpers/run-cli.js';

const TOKEN = 'abcd1234';
const ACK = `ORCA-ACK ${TOKEN}`;
const newToken = () => TOKEN;

/** Working until it receives the message, then done with a reply that ends with the ack line. */
const acks: Behavior = ({ received }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'done', message: `Handled it.\n${ACK}` });
/** Finished before the message and after it, with the given last reply. */
const repliesAfterSend =
  (message: string, state = 'done'): Behavior =>
  ({ received }) => (received.length === 0 ? { state: 'done', message: 'Earlier reply.' } : { state, message });

const run = (argv: string[], agents: FakeAgent[], opts: RunCliOptions = {}) => runCli(argv, agents, { newToken, ...opts });
const send = (text: string, agents: FakeAgent[], opts: RunCliOptions = {}, extra: string[] = []) => run(['broadcast', text, '--yes', '--timeout', '10s', ...extra], agents, opts);

const storeDir = (dir: string) => join(dir, 'orca-broadcast');
async function records(dir: string): Promise<BroadcastRecord[]> {
  const folder = join(storeDir(dir), 'broadcasts');
  const names = await readdir(folder).catch(() => [] as string[]);
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(folder, n), 'utf8')) as BroadcastRecord));
}
const hasPointer = async (dir: string) => (await readdir(storeDir(dir)).catch(() => [] as string[])).includes('current');

function target(paneKey: string, extra: Partial<BroadcastTarget> = {}): BroadcastTarget {
  return { paneKey, repoId: 'repo-repo', repo: 'repo', worktreeId: `wt-${paneKey}`, worktreePath: `/work/tree-${paneKey}`, worktree: `tree-${paneKey}`, role: 'session', orchestrationRunIds: [], lastHandle: null, baseline: null, messagePending: false, status: 'pending', reason: 'still-working', ...extra };
}
const seedBroadcast = (targets: BroadcastTarget[], extra: Partial<BroadcastRecord> = {}) => async (store: RecordStore) => {
  const record: BroadcastRecord = { id: 'b-1', token: TOKEN, text: 'earlier text', createdAt: '2026-01-01T00:00:00.000Z', status: 'open', targets, ...extra };
  await store.saveBroadcast(record);
  await store.setCurrent('broadcast', record.id);
};

describe('broadcast: the text', () => {
  it.each<[string, string, string]>([
    ['empty', '', 'empty text'],
    ['only spaces', '   ', 'empty text'],
    ['a newline inside', 'one\ntwo', 'control character'],
    ['a tab inside', 'one\ttwo', 'control character'],
    ['another control character', 'one\u0007two', 'control character'],
    ['1001 characters', 'x'.repeat(1001), '1001 characters'],
  ])('refuses %s with exit 2 and sends and writes nothing', async (_name, text, message) => {
    const { code, err, port, dir } = await send(text, [{ paneKey: 'a:1', behavior: acks }]);
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(port.listCalls).toBe(0);
    expect(port.sends).toEqual([]);
    expect(await records(dir)).toEqual([]);
  });

  it('accepts exactly 1000 code points, counting an emoji as one', async () => {
    const { code, port } = await send('😀'.repeat(1000), [{ paneKey: 'a:1', behavior: acks }]);
    expect(code).toBe(0);
    expect(port.sends).toHaveLength(1);
  });

  it('trims both ends and sends the exact one-line message with double quotes as typed', async () => {
    const { code, port } = await send('  say "hi" now \n', [{ paneKey: 'a:1', behavior: acks }]);
    expect(code).toBe(0);
    expect(port.sends[0]?.text).toBe(broadcastMessage('say "hi" now', TOKEN));
    expect(port.sends[0]?.text).toContain(`[orca-broadcast] The user sends you this message: "say "hi" now" Handle it now.`);
    expect(port.sends[0]?.text.endsWith(`The last line of your reply must be exactly: ${ACK}`)).toBe(true);
    expect(port.sends[0]?.text).not.toContain('\n');
  });

  it('reads --file, and refuses text together with --file or an unreadable file', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'orca-broadcast-file-'));
    const file = join(folder, 'text.txt');
    await writeFile(file, 'from a file\n');
    const ok = await run(['broadcast', '--file', file, '--yes', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: acks }]);
    expect(ok.code).toBe(0);
    expect(ok.port.sends[0]?.text).toContain('"from a file"');

    const both = await run(['broadcast', 'text', '--file', file, '--yes'], [{ paneKey: 'a:1', behavior: acks }]);
    expect(both.code).toBe(2);
    expect(both.port.listCalls).toBe(0);

    const missing = await run(['broadcast', '--file', join(folder, 'missing.txt'), '--yes'], [{ paneKey: 'a:1', behavior: acks }]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('cannot read --file');
    expect(missing.port.listCalls).toBe(0);
  });
});

describe('broadcast: the safety switch and the prompt', () => {
  it.each<[string, string[]]>([
    ['with text', ['broadcast', 'hello']],
    ['without text', ['broadcast']],
    ['with --json', ['broadcast', 'hello', '--json']],
  ])('refuses %s without --yes when there is no terminal, before anything is read', async (_name, argv) => {
    const { code, err, out, port } = await run(argv, [{ paneKey: 'a:1', behavior: acks }]);
    expect(code).toBe(2);
    expect(`${err}${out}`).toContain('refusing to send without an interactive terminal');
    expect(port.listCalls).toBe(0);
  });

  it('lists the targets, the exact message and the self line, then sends after a yes', async () => {
    const { code, err, questions, port } = await run(['broadcast', 'hello', '--timeout', '10s'], [
      { paneKey: 'a:1', repo: 'api', worktree: 'main', behavior: acks },
      { paneKey: 'b:2', repo: 'web', worktree: 'ui', behavior: acks },
      { paneKey: 's:9', repo: 'ops', worktree: 'me', behavior: working },
    ], { ask: ['y'], env: { ORCA_PANE_KEY: 's:9' } });
    expect(code).toBe(0);
    expect(questions).toEqual(['Send to 2 agents? [y/N] ']);
    expect(err).toContain('api/main (session)');
    expect(err).toContain('web/ui (session)');
    expect(err).toContain(broadcastMessage('hello', TOKEN));
    expect(err).toContain('Not sent to this session: ops/me (session)');
    expect(port.sendsTo('s:9')).toBe(0);
  });

  it('sends nothing and writes nothing after a no', async () => {
    const { code, err, port, dir } = await run(['broadcast', 'hello'], [{ paneKey: 'a:1', behavior: acks }], { ask: ['n'] });
    expect(code).toBe(2);
    expect(err).toContain('cancelled: nothing was sent');
    expect(port.sends).toEqual([]);
    expect(await records(dir)).toEqual([]);
  });

  it('exits 130 and writes nothing on Ctrl-C at the prompt', async () => {
    const { code, port, dir } = await run(['broadcast', 'hello'], [{ paneKey: 'a:1', behavior: acks }], { ask: [CTRL_C] });
    expect(code).toBe(130);
    expect(port.sends).toEqual([]);
    expect(await records(dir)).toEqual([]);
  });
});

describe('broadcast: the targets', () => {
  it('messages working and done Claude agents, never waiting or non-Claude agents, and shows self on its own line', async () => {
    const { code, out, port } = await send('hello', [
      { paneKey: 'w:1', behavior: acks },
      { paneKey: 'd:2', behavior: repliesAfterSend(`Done.\n${ACK}`) },
      { paneKey: 'p:3', behavior: () => ({ state: 'waiting', message: null }) },
      { paneKey: 'x:4', agentType: 'codex', agentIdentity: 'codex', behavior: working },
      { paneKey: 's:9', behavior: working },
    ], { env: { ORCA_PANE_KEY: 's:9' } });
    expect(code).toBe(0);
    expect(port.sends.map((s) => s.handle).sort()).toEqual(['term_d:2', 'term_w:1']);
    expect(out).toContain('self (not sent)');
    expect(out).not.toContain('tree-p:3');
  });

  it('prints "nothing to broadcast" and exits 0 when no agent is sendable, and writes nothing', async () => {
    const { code, out, port, dir } = await send('hello', [{ paneKey: 'p:1', behavior: () => ({ state: 'waiting', message: null }) }, { paneKey: 's:9', behavior: working }], { env: { ORCA_PANE_KEY: 's:9' } });
    expect(code).toBe(0);
    expect(out).toContain('nothing to broadcast');
    expect(out).toContain('self (not sent)');
    expect(port.sends).toEqual([]);
    expect(await records(dir)).toEqual([]);
    expect(await hasPointer(dir)).toBe(false);
  });

  it('prints no self line when the pane key is unset', async () => {
    const { out } = await send('hello', [{ paneKey: 'a:1', behavior: acks }]);
    expect(out).not.toContain('self (not sent)');
  });

  it('records a target that vanished after the yes as gone and never sends to it', async () => {
    const { code, port, dir } = await send('hello', [
      { paneKey: 'a:1', behavior: acks },
      { paneKey: 'b:2', behavior: acks, terminalAt: (listing) => (listing >= 2 ? 'missing' : 'ok') },
    ]);
    expect(code).toBe(1);
    expect(port.sendsTo('b:2')).toBe(0);
    const [record] = await records(dir);
    expect(record?.targets.map((t) => [t.paneKey, t.status, t.reason])).toEqual([['a:1', 'acked', null], ['b:2', 'gone', 'terminal-closed']]);
  });

  it('prints "nothing to broadcast" and writes nothing when every target vanished after the yes', async () => {
    const { code, out, port, dir } = await send('hello', [{ paneKey: 'a:1', behavior: acks, terminalAt: (listing) => (listing >= 2 ? 'missing' : 'ok') }]);
    expect(code).toBe(0);
    expect(out).toContain('nothing to broadcast');
    expect(port.sends).toEqual([]);
    expect(await records(dir)).toEqual([]);
  });

  it('clears the pid from the record and sends nothing when the pointer cannot be written', async () => {
    const { code, port, dir } = await send('hello', [{ paneKey: 'a:1', behavior: acks }], {
      seed: async (_store, base) => {
        await mkdir(join(base, 'orca-broadcast', 'current.tmp'), { recursive: true }); // makes the atomic pointer write fail
      },
    });
    expect(code).toBe(2);
    expect(port.sends).toEqual([]);
    const [record] = await records(dir);
    expect(record).toMatchObject({ status: 'open' });
    expect(record).not.toHaveProperty('pid');
  });

  it('exits 2 and writes nothing when the listing after the yes fails', async () => {
    const { code, port, dir } = await send('hello', [{ paneKey: 'a:1', behavior: acks }], { configure: (p) => (p.failListingsFrom = 2) });
    expect(code).toBe(2);
    expect(port.sends).toEqual([]);
    expect(await records(dir)).toEqual([]);
  });
});

describe('broadcast: the record and the sending', () => {
  it('writes the open record, with the pid and start time, before the first send', async () => {
    let seen: BroadcastRecord | undefined;
    const base = await mkdtemp(join(tmpdir(), 'orca-broadcast-watch-'));
    await send('hello', [{ paneKey: 'a:1', behavior: acks }], {
      env: { XDG_STATE_HOME: base },
      configure: (port) => {
        port.onSend = async () => {
          seen ??= (await records(base))[0];
        };
      },
    });
    expect(seen).toMatchObject({ status: 'open', token: TOKEN, text: 'hello', pid: process.pid, startTime: expect.any(String), targets: [{ paneKey: 'a:1', messagePending: true, status: 'pending' }] });
    expect(seen?.id).toMatch(/^\d{8}T\d{9}Z-abcd1234$/);
  });

  it('stores the identity of each target, its role and run ids, and the baseline taken at the accepted send', async () => {
    const { dir } = await send('hello', [{ paneKey: 'a:1', repo: 'api', worktree: 'main', behavior: ({ received }) => (received.length === 0 ? { state: 'done', message: 'Before.' } : { state: 'done', message: `After.\n${ACK}` }) }]);
    const [record] = await records(dir);
    expect(record?.targets[0]).toMatchObject({ paneKey: 'a:1', repoId: 'repo-api', repo: 'api', worktreeId: 'wt-a:1', worktreePath: '/work/main', worktree: 'main', role: 'session', orchestrationRunIds: [], lastHandle: 'term_a:1', baseline: 'Before.', messagePending: false, status: 'acked' });
  });

  it('lists and messages coordinators first, and records the role and run ids of each target', async () => {
    const { code, port, dir } = await send('hello', [{ paneKey: 'b:2', behavior: acks }, { paneKey: 'a:1', behavior: acks }], { configure: (p) => (p.coordinatorsAt = () => ['a:1']) });
    expect(code).toBe(0);
    expect(port.sends.map((s) => s.handle)).toEqual(['term_a:1', 'term_b:2']);
    const [record] = await records(dir);
    expect(record?.targets.map((t) => [t.paneKey, t.role, t.orchestrationRunIds])).toEqual([['a:1', 'coordinator', ['run_0']], ['b:2', 'session', []]]);
  });

  it('keeps send-failed over waiting-permission when the target later goes waiting', async () => {
    const { dir } = await send('hello', [{ paneKey: 'a:1', behavior: ({ listCalls }) => (listCalls >= 4 ? { state: 'waiting', message: null } : { state: 'working', message: null }) }], { configure: (p) => (p.sendResult = () => ({ accepted: false, reason: 'nope' })) });
    expect((await records(dir))[0]?.targets[0]).toMatchObject({ reason: 'send-failed', messagePending: true });
  });

  it('skips a target that goes waiting before its send, and sends once it leaves waiting', async () => {
    let listings = 0;
    const { code, port, dir } = await send('hello', [
      {
        paneKey: 'a:1',
        behavior: ({ received, listCalls }) => {
          listings = listCalls;
          if (received.length > 0) return { state: 'done', message: `Done.\n${ACK}` };
          return listCalls === 3 || listCalls === 4 ? { state: 'waiting', message: null } : { state: 'working', message: null };
        },
      },
    ]);
    expect(listings).toBeGreaterThan(4);
    expect(code).toBe(0);
    expect(port.sendsTo('a:1')).toBe(1);
    expect((await records(dir))[0]?.targets[0]?.status).toBe('acked');
  });

  it('checks a fresh row right before the send, not only the poll snapshot', async () => {
    const { code, port } = await send('hello', [
      { paneKey: 'a:1', behavior: ({ received, listCalls }) => (received.length > 0 ? { state: 'done', message: `Done.\n${ACK}` } : listCalls === 3 ? { state: 'waiting', message: null } : { state: 'working', message: null }) },
    ]);
    expect(code).toBe(0);
    expect(port.sendsTo('a:1')).toBe(1); // listing 3 is the fresh read before the first send; the skipped send was retried at the next poll
    expect(port.listCalls).toBeGreaterThanOrEqual(5);
  });

  it('marks a rejected send send-failed and keeps it pending until the timeout, exit 1', async () => {
    const { code, port, dir, out } = await send('hello', [{ paneKey: 'a:1', behavior: acks }], { configure: (p) => (p.sendResult = () => ({ accepted: false, reason: 'nope' })) });
    expect(code).toBe(1);
    expect(port.sendsTo('a:1')).toBe(1); // sticky: never retried within the invocation
    const [record] = await records(dir);
    expect(record).toMatchObject({ status: 'open' });
    expect(record?.targets[0]).toMatchObject({ status: 'pending', reason: 'send-failed', messagePending: true });
    expect(out).toContain('send-failed');
  });

  it('treats a send that throws as send-failed', async () => {
    const { code, dir } = await send('hello', [{ paneKey: 'a:1', behavior: acks }], { configure: (p) => (p.onSend = () => { throw new Error('boom'); }) });
    expect(code).toBe(1);
    expect((await records(dir))[0]?.targets[0]).toMatchObject({ reason: 'send-failed', messagePending: true });
  });

  it('shows still-working for a sent target that has not replied yet', async () => {
    const { code, dir } = await send('hello', [{ paneKey: 'a:1', behavior: ({ received }) => (received.length === 0 ? { state: 'done', message: 'Earlier.' } : { state: 'working', message: null }) }]);
    expect(code).toBe(1);
    expect((await records(dir))[0]?.targets[0]).toMatchObject({ status: 'pending', reason: 'still-working', messagePending: false });
  });
});

describe('broadcast: the ack proof', () => {
  it.each<[string, Behavior, number]>([
    ['the ack line is the last line', repliesAfterSend(`Done.\n${ACK}`), 0],
    ['the ack line is wrapped in one pair of backticks', repliesAfterSend(`Done.\n\`${ACK}\``), 0],
    ['the agent is working with the new reply', repliesAfterSend(`Done.\n${ACK}`, 'working'), 0],
    ['the ack line has another token', repliesAfterSend('Done.\nORCA-ACK 0000ffff'), 1],
    ['the ack line is not the last line', repliesAfterSend(`${ACK}\nAnd more.`), 1],
    ['the reply is the same as the baseline', () => ({ state: 'done', message: `Old.\n${ACK}` }), 1],
    ['the reply is null', ({ received }) => ({ state: 'done', message: received.length === 0 ? 'Earlier.' : null }), 1],
    ['the agent is waiting with the ack reply', repliesAfterSend(`Done.\n${ACK}`, 'waiting'), 1],
  ])('when %s the exit code is %i', async (_name, behavior, exitCode) => {
    const { code } = await send('hello', [{ paneKey: 'a:1', behavior }]);
    expect(code).toBe(exitCode);
  });

  it('does not ack while the message is still pending, even if the reply already ends with the ack line', async () => {
    const { code, dir } = await send('hello', [{ paneKey: 'a:1', behavior: () => ({ state: 'done', message: `Done.\n${ACK}` }) }], { configure: (p) => (p.sendResult = () => ({ accepted: false, reason: 'nope' })) });
    expect(code).toBe(1);
    expect((await records(dir))[0]?.targets[0]).toMatchObject({ status: 'pending', reason: 'send-failed', messagePending: true });
  });

  it('keeps an ack permanent when the agent replies differently later', async () => {
    const { code, dir } = await send('hello', [
      { paneKey: 'a:1', behavior: ({ received, listCalls }) => (received.length === 0 ? { state: 'working', message: null } : { state: 'done', message: listCalls <= 6 ? `Done.\n${ACK}` : 'Unrelated later reply.' }) },
      { paneKey: 'b:2', behavior: ({ received, listCalls }) => (received.length > 0 && listCalls >= 7 ? { state: 'done', message: `Late.\n${ACK}` } : { state: 'working', message: null }) },
    ]);
    expect(code).toBe(0);
    expect((await records(dir))[0]?.targets.map((t) => t.status)).toEqual(['acked', 'acked']);
  });
});

describe('broadcast: the outcome', () => {
  it('closes the record, clears the pointer and the pid, and exits 0 when every target acked', async () => {
    const { code, dir, out } = await send('hello', [{ paneKey: 'a:1', behavior: acks }]);
    expect(code).toBe(0);
    const [record] = await records(dir);
    expect(record).toMatchObject({ status: 'closed' });
    expect(record).not.toHaveProperty('pid');
    expect(record).not.toHaveProperty('startTime');
    expect(await hasPointer(dir)).toBe(false);
    expect(out).toContain('acked');
  });

  it('on a timeout keeps the record and the pointer, clears the pid, exits 1 and prints the table', async () => {
    const clock = fakeClock();
    const { code, dir, out } = await send('hello', [{ paneKey: 'a:1', behavior: working }], { clock });
    expect(code).toBe(1);
    const [record] = await records(dir);
    expect(record).toMatchObject({ status: 'open' });
    expect(record).not.toHaveProperty('pid');
    expect(await hasPointer(dir)).toBe(true);
    expect(out).toContain('still-working');
    expect(clock.slept).toBeGreaterThanOrEqual(10_000);
  });

  it('uses 10 minutes as the default timeout', async () => {
    const clock = fakeClock();
    await run(['broadcast', 'hello', '--yes'], [{ paneKey: 'a:1', behavior: working }], { clock });
    expect(clock.slept).toBeGreaterThanOrEqual(600_000);
    expect(clock.slept).toBeLessThan(610_000);
  });

  it('closes the record and exits 1 when a target is gone and the others acked', async () => {
    const { code, dir } = await send('hello', [
      { paneKey: 'a:1', behavior: acks },
      { paneKey: 'b:2', behavior: acks, terminalAt: (listing) => (listing >= 5 ? 'missing' : 'ok') },
    ]);
    expect(code).toBe(1);
    const [record] = await records(dir);
    expect(record?.targets.map((t) => t.status)).toEqual(['acked', 'gone']);
    expect(record?.status).toBe('closed');
    expect(await hasPointer(dir)).toBe(false);
  });

  it('exits 130 on a signal during the wait, with the record kept and the pid cleared', async () => {
    const signals = new EventEmitter();
    const clock = fakeClock();
    clock.onSleep = () => signals.emit('SIGTERM');
    const { code, dir } = await send('hello', [{ paneKey: 'a:1', behavior: working }], { signals, clock });
    expect(code).toBe(130);
    const [record] = await records(dir);
    expect(record).toMatchObject({ status: 'open' });
    expect(record).not.toHaveProperty('pid');
    expect(await hasPointer(dir)).toBe(true);
  });

  it('exits 2 when Orca fails during the wait, with the record kept and the pid cleared', async () => {
    const { code, dir, err } = await send('hello', [{ paneKey: 'a:1', behavior: working }], { configure: (p) => (p.failListingsFrom = 5) });
    expect(code).toBe(2);
    expect(err).toContain('orca-broadcast:');
    const [record] = await records(dir);
    expect(record).toMatchObject({ status: 'open' });
    expect(record).not.toHaveProperty('pid');
  });

  it('prints one JSON object in the pause shape with the record and no run', async () => {
    const { code, out, err } = await send('hello', [{ paneKey: 'a:1', behavior: acks }], {}, ['--json']);
    expect(code).toBe(0);
    expect(err).toBe('');
    const object = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(object).sort()).toEqual(['command', 'error', 'exitCode', 'outcome', 'record', 'run']);
    expect(object).toMatchObject({ command: 'broadcast', outcome: 'done', exitCode: 0, run: null, error: null, record: { token: TOKEN, text: 'hello', status: 'closed', targets: [{ paneKey: 'a:1', status: 'acked' }] } });
  });

  it('gives record null for a refusal and for nothing to broadcast', async () => {
    const refused = await send('', [{ paneKey: 'a:1', behavior: acks }], {}, ['--json']);
    expect(JSON.parse(refused.out)).toMatchObject({ command: 'broadcast', outcome: 'error', exitCode: 2, record: null });
    const nothing = await send('hello', [], {}, ['--json']);
    expect(JSON.parse(nothing.out)).toEqual({ command: 'broadcast', outcome: 'nothing-to-do', exitCode: 0, run: null, record: null, error: null });
  });
});

describe('broadcast and the other record', () => {
  it('is refused while a pause run is open', async () => {
    const { code, err, port } = await send('hello', [{ paneKey: 'a:1', behavior: acks }], { seed: (store) => seedOpenRun(store, [agentRecord('a:1')]) });
    expect(code).toBe(2);
    expect(err).toContain('A pause run is open; resume or close it first.');
    expect(port.sends).toEqual([]);
  });

  it.each<[string, string[]]>([
    ['a text', ['broadcast', 'other', '--yes']],
    ['the same text', ['broadcast', 'earlier text', '--yes']],
    ['no text', ['broadcast', '--yes']],
  ])('is refused with %s while a broadcast is open, and the record stays', async (_name, argv) => {
    const { code, err, port, dir } = await run(argv, [{ paneKey: 'a:1', behavior: acks }], { seed: seedBroadcast([target('a:1')]) });
    expect(code).toBe(2);
    expect(err).toContain('A broadcast is open; close it first.');
    expect(port.sends).toEqual([]);
    expect((await records(dir))[0]).toMatchObject({ id: 'b-1', status: 'open' });
  });

  it('is refused with no text when nothing is open', async () => {
    const { code, err, port } = await run(['broadcast', '--yes'], [{ paneKey: 'a:1', behavior: acks }]);
    expect(code).toBe(2);
    expect(err).toContain('No broadcast is open; give a text.');
    expect(port.sends).toEqual([]);
  });

  it('makes pause exit 2 and write nothing while a broadcast is open', async () => {
    const { code, err, port, dir } = await run(['pause', '--yes'], [{ paneKey: 'a:1', behavior: working }], { seed: seedBroadcast([target('a:1')]) });
    expect(code).toBe(2);
    expect(err).toContain('A broadcast is open; close it first.');
    expect(port.sends).toEqual([]);
    expect(await readdir(storeDir(dir))).not.toContain('pauses');
    expect((await records(dir))[0]).toMatchObject({ id: 'b-1', status: 'open' });
    expect(JSON.parse(await readFile(join(storeDir(dir), 'current'), 'utf8'))).toEqual({ kind: 'broadcast', id: 'b-1' });
  });

  it('makes pause exit 2 with a JSON error object while a broadcast is open', async () => {
    const { code, out } = await run(['pause', '--yes', '--json'], [{ paneKey: 'a:1', behavior: working }], { seed: seedBroadcast([target('a:1')]) });
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ command: 'pause', outcome: 'error', exitCode: 2, run: null, record: null });
  });

  it('makes pause exit 2 and write nothing when a pause run and a broadcast are both open', async () => {
    const { code, err, port } = await run(['pause', '--yes'], [{ paneKey: 'a:1', behavior: working }], {
      seed: async (store) => {
        await seedBroadcast([target('a:1')])(store);
        await seedOpenRun(store, [agentRecord('a:1')]);
      },
    });
    expect(code).toBe(2);
    expect(err).toContain('A broadcast is open; close it first.');
    expect(port.sends).toEqual([]);
  });

  it('makes resume say "nothing to resume" with exit 0 when only a broadcast is open', async () => {
    const { code, out, port } = await run(['resume', '--yes'], [{ paneKey: 'a:1', behavior: working }], { seed: seedBroadcast([target('a:1')]) });
    expect(code).toBe(0);
    expect(out).toContain('nothing to resume');
    expect(port.sends).toEqual([]);
  });
});

describe('close and a broadcast', () => {
  const seedTargets = seedBroadcast([target('a:1'), target('b:2', { status: 'acked', reason: null }), target('c:3', { status: 'gone', reason: 'terminal-closed' })], { pid: 999_999, startTime: '1' });

  it('abandons the pending targets with reason closed, says it closed a broadcast, clears the pointer and the pid', async () => {
    const { code, out, dir, port } = await run(['close'], [], { seed: seedTargets });
    expect(code).toBe(0);
    expect(out).toContain('closed broadcast b-1');
    expect(out).toContain('abandoned');
    expect(port.sends).toEqual([]);
    const [record] = await records(dir);
    expect(record).toMatchObject({ status: 'closed' });
    expect(record).not.toHaveProperty('pid');
    expect(record?.targets.map((t) => [t.status, t.reason])).toEqual([['abandoned', 'closed'], ['acked', null], ['gone', 'terminal-closed']]);
    expect(await hasPointer(dir)).toBe(false);
  });

  it('gives the JSON shape with the closed record and no run', async () => {
    const { out } = await run(['close', '--json'], [], { seed: seedTargets });
    expect(JSON.parse(out)).toMatchObject({ command: 'close', outcome: 'done', exitCode: 0, run: null, error: null, record: { id: 'b-1', status: 'closed' } });
  });

  it('lets a new broadcast start after the close', async () => {
    const { dir } = await run(['close'], [], { seed: seedTargets });
    const again = await runCli(['broadcast', 'next', '--yes', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: acks }], { newToken, env: { XDG_STATE_HOME: dir } });
    expect(again.code).toBe(0);
  });

  it('closes the pause run first, leaves the broadcast open and warns when both are open', async () => {
    const { code, out, err, dir } = await run(['close'], [], {
      seed: async (store) => {
        await seedBroadcast([target('a:1')])(store);
        await seedOpenRun(store, [agentRecord('a:1')]);
      },
    });
    expect(code).toBe(0);
    expect(out).not.toContain('closed broadcast');
    expect(err).toContain('broadcast b-1 is also open');
    expect((await records(dir))[0]).toMatchObject({ status: 'open' });
  });

  it('gives JSON with the pause run and no record when both kinds are open, and no warning field', async () => {
    const { out, err } = await run(['close', '--json'], [], {
      seed: async (store) => {
        await seedBroadcast([target('a:1')])(store);
        await seedOpenRun(store, [agentRecord('a:1')]);
      },
    });
    const object = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(object).sort()).toEqual(['command', 'error', 'exitCode', 'outcome', 'record', 'run']);
    expect(object).toMatchObject({ command: 'close', outcome: 'done', record: null, run: { status: 'closed' } });
    expect(err).toBe('');
  });

  it('keeps the pause run JSON and adds record null', async () => {
    const { out } = await run(['close', '--json'], [], { seed: (store) => seedOpenRun(store, [agentRecord('a:1')]) });
    expect(JSON.parse(out)).toMatchObject({ command: 'close', outcome: 'done', exitCode: 0, record: null, run: { status: 'closed' } });
  });
});

describe('broadcast flags', () => {
  it.each<[string[], string]>([
    [['broadcast', 'hi', '--reason', 'away', '--yes'], '--reason applies only to pause'],
    [['pause', '--file', 'x', '--yes'], '--file applies only to broadcast'],
    [['broadcast', 'one', 'two', '--yes'], 'broadcast takes one text'],
    [['resume', '--timeout', '5s', '--yes'], '--timeout applies only to pause and broadcast'],
  ])('%j exits 2 with the usage error', async (argv, message) => {
    const { code, err, port } = await run(argv, [{ paneKey: 'a:1', behavior: acks }]);
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(port.listCalls).toBe(0);
  });
});
