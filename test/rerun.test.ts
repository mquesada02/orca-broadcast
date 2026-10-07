import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { broadcastMessage } from '../src/broadcast.js';
import type { RecordStore } from '../src/store.js';
import type { BroadcastRecord, BroadcastTarget } from '../src/types.js';
import { broadcastTarget, fakeClock, openBroadcastRecord, working, type Behavior, type FakeAgent } from './helpers/fake-orca.js';
import { hasPointer, readBroadcasts, statusOf as status, storeDir } from './helpers/records.js';
import { CTRL_C, runCli, type RunCliOptions } from './helpers/run-cli.js';

const TOKEN = 'abcd1234';
const ACK = `ORCA-ACK ${TOKEN}`;
const TEXT = 'earlier text';
const STORE = { pid: 4242, readStartTime: () => '77' };

const run = (argv: string[], agents: FakeAgent[], opts: RunCliOptions = {}) => runCli(argv, agents, { storeOptions: STORE, ...opts });
const rerun = (agents: FakeAgent[], opts: RunCliOptions = {}, extra: string[] = []) => run(['broadcast', '--yes', '--timeout', '10s', ...extra], agents, opts);

/** Replied to the earlier send with a reply that ends with the ack line. */
const acks: Behavior = () => ({ state: 'done', message: `Handled it.\n${ACK}` });
/** Replied after the send, without the ack line. */
const repliesWithoutAck: Behavior = () => ({ state: 'done', message: 'Handled it, no ack line.' });
/** Has not replied since the send. */
const silent: Behavior = () => ({ state: 'working', message: null });
/** Replies to the message it received: with the ack line once it has it. */
const acksWhenSent: Behavior = ({ received }) => (received.length === 0 ? { state: 'done', message: 'Earlier reply.' } : { state: 'done', message: `Done.\n${ACK}` });

/** A target whose message was accepted earlier; its baseline is `Earlier reply.`. */
const sent = (paneKey: string, extra: Partial<BroadcastTarget> = {}) => broadcastTarget(paneKey, { baseline: 'Earlier reply.', ...extra });
/** A target whose message was never sent. */
const unsent = (paneKey: string, extra: Partial<BroadcastTarget> = {}) => broadcastTarget(paneKey, { messagePending: true, reason: null, ...extra });
/** A target whose last send failed. */
const failed = (paneKey: string) => unsent(paneKey, { reason: 'send-failed' });

const seed = (targets: BroadcastTarget[], extra: Partial<BroadcastRecord> = {}) => async (store: RecordStore) => {
  const record = openBroadcastRecord(targets, extra);
  await store.saveBroadcast(record);
  await store.setCurrent('broadcast', record.id);
};

const readRecord = async (dir: string): Promise<BroadcastRecord> => (await readBroadcasts(dir))[0] as BroadcastRecord;
const reasons = (record: BroadcastRecord) => Object.fromEntries(record.targets.map((t) => [t.paneKey, t.reason]));

describe('re-run: continuing the open broadcast', () => {
  it.each<[string, string[]]>([
    ['no text', ['broadcast', '--yes']],
    ['the same text', ['broadcast', TEXT, '--yes']],
    ['the same text after trimming', ['broadcast', `  ${TEXT}  `, '--yes']],
  ])('continues with %s: same token, no send, the ack closes the record', async (_name, argv) => {
    const { code, port, dir } = await run(argv, [{ paneKey: 'a:1', behavior: acks }], { seed: seed([sent('a:1')]) });
    expect(code).toBe(0);
    expect(port.sends).toEqual([]);
    const record = await readRecord(dir);
    expect(record).toMatchObject({ token: TOKEN, status: 'closed' });
    expect(record).not.toHaveProperty('pid');
    expect(await hasPointer(dir)).toBe(false);
  });

  it('continues with --file text that has a trailing newline', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'orca-broadcast-file-'));
    const file = join(folder, 'text.txt');
    await writeFile(file, `${TEXT}\n`);
    const { code, port } = await run(['broadcast', '--file', file, '--yes'], [{ paneKey: 'a:1', behavior: acks }], { seed: seed([sent('a:1')]) });
    expect(code).toBe(0);
    expect(port.sends).toEqual([]);
  });

  it('is a pure wait with no prompt when nothing needs a send', async () => {
    const { code, questions } = await run(['broadcast'], [{ paneKey: 'a:1', behavior: acks }], { seed: seed([sent('a:1')]), ask: [] });
    expect(code).toBe(0);
    expect(questions).toEqual([]);
  });

  it('still needs --yes without a terminal, even for a pure wait', async () => {
    const { code, err, port } = await run(['broadcast'], [{ paneKey: 'a:1', behavior: acks }], { seed: seed([sent('a:1')]) });
    expect(code).toBe(2);
    expect(err).toContain('refusing to send without an interactive terminal');
    expect(port.listCalls).toBe(0);
  });

  it('waits a fresh --timeout and keeps the record open with the pid cleared', async () => {
    const clock = fakeClock();
    const { code, dir } = await rerun([{ paneKey: 'a:1', behavior: silent }], { seed: seed([sent('a:1')]), clock });
    expect(code).toBe(1);
    expect(clock.slept).toBeGreaterThanOrEqual(10_000);
    const record = await readRecord(dir);
    expect(record.status).toBe('open');
    expect(record).not.toHaveProperty('pid');
    expect(await hasPointer(dir)).toBe(true);
  });

  it('never adds a target', async () => {
    const { port, dir } = await rerun([{ paneKey: 'a:1', behavior: acks }, { paneKey: 'n:9', behavior: working }], { seed: seed([sent('a:1')]) });
    expect(port.sendsTo('n:9')).toBe(0);
    expect((await readRecord(dir)).targets.map((t) => t.paneKey)).toEqual(['a:1']);
  });
});

describe('re-run: what is sent again', () => {
  const targets = () => [sent('a:1'), unsent('b:2'), failed('c:3')];
  const agents = (): FakeAgent[] => [{ paneKey: 'a:1', behavior: silent }, { paneKey: 'b:2', behavior: acksWhenSent }, { paneKey: 'c:3', behavior: acksWhenSent }];

  it('prompts for, and sends only to, the targets never sent or send-failed, with the same token and text', async () => {
    const { code, port, questions, err } = await run(['broadcast', '--timeout', '10s'], agents(), { seed: seed(targets()), ask: ['y'] });
    expect(questions).toEqual(['Send to 2 agents? [y/N] ']);
    expect(err).toContain(broadcastMessage(TEXT, TOKEN));
    expect(port.sendsTo('a:1')).toBe(0);
    expect(port.sends.filter((s) => s.text === broadcastMessage(TEXT, TOKEN)).map((s) => s.handle).sort()).toEqual(['term_b:2', 'term_c:3']);
    expect(code).toBe(1); // a:1 never replies
  });

  it('prompts even when the target to send to is waiting now, and sends after it leaves waiting', async () => {
    const behavior: Behavior = ({ listCalls, received }) => (received.length > 0 ? { state: 'done', message: `Done.\n${ACK}` } : listCalls < 4 ? { state: 'waiting', message: null } : { state: 'working', message: null });
    const { code, questions, port } = await run(['broadcast', '--timeout', '30s'], [{ paneKey: 'b:2', behavior }], { seed: seed([unsent('b:2')]), ask: ['y'] });
    expect(questions).toEqual(['Send to 1 agent? [y/N] ']);
    expect(port.sendsTo('b:2')).toBe(1);
    expect(code).toBe(0);
  });

  it('does not send again to a target whose message was accepted, even when it replied without the ack line', async () => {
    const { port, dir } = await rerun([{ paneKey: 'a:1', behavior: repliesWithoutAck }], { seed: seed([sent('a:1')]) });
    expect(port.sends).toEqual([]);
    expect(reasons(await readRecord(dir))).toEqual({ 'a:1': 'no-ack' });
  });

  it('holds the pid and start time of this process while the prompt is open', async () => {
    const seen: BroadcastRecord[] = [];
    const dirRef = { dir: '' };
    const { code, dir } = await run(['broadcast'], agents(), {
      seed: async (store, d) => {
        dirRef.dir = d;
        await seed(targets(), { pid: 1, startTime: '5' })(store);
      },
      ask: [() => {
        // read while the prompt is open: the early save is already on disk
        seen.push(JSON.parse(readFileSync(join(storeDir(dirRef.dir), 'broadcasts', 'b-1.json'), 'utf8')) as BroadcastRecord);
        return 'n';
      }],
    });
    expect(code).toBe(2);
    expect(seen[0]).toMatchObject({ pid: 4242, startTime: '77' });
    expect(await readRecord(dir)).not.toHaveProperty('pid');
  });

  it('after a no: exit 2, nothing sent, the saved send-failed and the targets as they were, the pid cleared', async () => {
    const { code, err, port, dir } = await run(['broadcast'], agents(), { seed: seed(targets(), { pid: 1, startTime: '5' }), ask: ['n'] });
    expect(code).toBe(2);
    expect(err).toContain('cancelled: nothing was sent');
    expect(port.sends).toEqual([]);
    const record = await readRecord(dir);
    expect(reasons(record)).toEqual({ 'a:1': 'still-working', 'b:2': null, 'c:3': 'send-failed' });
    expect(record).not.toHaveProperty('pid');
    expect(record.status).toBe('open');
  });

  it('a Ctrl-C at the prompt exits 130 and keeps the saved send-failed', async () => {
    const { code, dir } = await run(['broadcast'], agents(), { seed: seed(targets()), ask: [CTRL_C] });
    expect(code).toBe(130);
    const record = await readRecord(dir);
    expect(reasons(record)['c:3']).toBe('send-failed');
    expect(record).not.toHaveProperty('pid');
  });

  it('retries a send-failed target after the prompt, and a rejected retry stops the loop early', async () => {
    const clock = fakeClock();
    const { code, port, dir } = await run(['broadcast', '--yes', '--timeout', '10s'], [{ paneKey: 'c:3', behavior: acksWhenSent }], {
      seed: seed([failed('c:3')]),
      clock,
      configure: (p) => (p.sendResult = () => ({ accepted: false, reason: 'nope' })),
    });
    expect(port.sendsTo('c:3')).toBe(1);
    expect(code).toBe(1);
    expect(clock.slept).toBe(0);
    const record = await readRecord(dir);
    expect(record.status).toBe('open');
    expect(record).not.toHaveProperty('pid');
    expect(reasons(record)).toEqual({ 'c:3': 'send-failed' });
  });

  it('marks a needs-send target that cannot be located as gone, with no prompt and no send', async () => {
    const { code, questions, port, dir } = await run(['broadcast'], [{ paneKey: 'a:1', behavior: acks }, { paneKey: 'b:2', hasTerminal: false, behavior: silent }], { seed: seed([sent('a:1'), unsent('b:2')]), ask: [] });
    expect(questions).toEqual([]);
    expect(port.sends).toEqual([]);
    expect(code).toBe(1);
    const record = await readRecord(dir);
    expect(status(record)).toEqual({ 'a:1': 'acked', 'b:2': 'gone' });
    expect(reasons(record)['b:2']).toBe('terminal-closed');
    expect(record.status).toBe('closed');
  });
});

describe('re-run: no-ack, early stop and late acks', () => {
  it('shows no-ack for a reply without the ack line, and a later ack still counts', async () => {
    const behavior: Behavior = ({ listCalls }) => (listCalls < 4 ? { state: 'done', message: 'Handled it.' } : { state: 'done', message: `Handled it.\n${ACK}` });
    const { code, dir, port } = await rerun([{ paneKey: 'a:1', behavior }], { seed: seed([sent('a:1')]) });
    expect(code).toBe(0);
    expect(port.sends).toEqual([]);
    expect(status(await readRecord(dir))).toEqual({ 'a:1': 'acked' });
  });

  it('orders the reasons: send-failed, then waiting-permission, then no-ack, then still-working', async () => {
    const { dir } = await rerun(
      [
        { paneKey: 'w:1', behavior: () => ({ state: 'waiting', message: 'A new reply.' }) },
        { paneKey: 'n:2', behavior: repliesWithoutAck },
        { paneKey: 's:3', behavior: silent },
        { paneKey: 'f:4', behavior: repliesWithoutAck },
      ],
      { seed: seed([sent('w:1'), sent('n:2'), sent('s:3'), failed('f:4')]), configure: (p) => (p.sendResult = () => ({ accepted: false, reason: 'nope' })) },
    );
    expect(reasons(await readRecord(dir))).toEqual({ 'w:1': 'waiting-permission', 'n:2': 'no-ack', 's:3': 'still-working', 'f:4': 'send-failed' });
  });

  it('keeps waiting while a target other than the send-failed ones is pending', async () => {
    const clock = fakeClock();
    await run(['broadcast', '--yes', '--timeout', '10s'], [{ paneKey: 'c:3', behavior: silent }, { paneKey: 'a:1', behavior: silent }], {
      seed: seed([failed('c:3'), sent('a:1')]),
      clock,
      configure: (p) => (p.sendResult = () => ({ accepted: false, reason: 'nope' })),
    });
    expect(clock.slept).toBeGreaterThanOrEqual(10_000);
  });

  it('ignores a late ack on an abandoned target, and does not count it in the exit code', async () => {
    const { code, dir } = await rerun([{ paneKey: 'a:1', behavior: acks }, { paneKey: 'b:2', behavior: acks }], { seed: seed([sent('a:1'), sent('b:2', { status: 'abandoned', reason: 'closed' })]) });
    expect(code).toBe(0);
    expect(status(await readRecord(dir))).toEqual({ 'a:1': 'acked', 'b:2': 'abandoned' });
  });

  it('refreshes the recorded role and run ids on each poll', async () => {
    const { dir } = await rerun([{ paneKey: 'a:1', behavior: acks }], { seed: seed([sent('a:1', { role: 'session' })]), configure: (p) => (p.coordinatorsAt = () => ['a:1']) });
    expect((await readRecord(dir)).targets[0]).toMatchObject({ role: 'coordinator', orchestrationRunIds: ['run_0'] });
  });
});

describe('re-run: the invoking session', () => {
  it('is never in scope: shown on the self line with its saved status, not in the table, and it keeps the record open', async () => {
    const { code, out, dir } = await rerun([{ paneKey: 'a:1', repo: 'api', worktree: 'me', behavior: silent }, { paneKey: 'b:2', repo: 'web', worktree: 'ui', behavior: acks }], {
      seed: seed([sent('a:1'), sent('b:2')]),
      env: { ORCA_PANE_KEY: 'a:1' },
    });
    expect(code).toBe(0);
    expect(out).toContain('self (not sent)');
    expect(out).toMatch(/api\s+me\s+session\s+pending/);
    expect(out.match(/\bme\b/g)).toHaveLength(1);
    const record = await readRecord(dir);
    expect(record.status).toBe('open');
    expect(status(record)).toEqual({ 'a:1': 'pending', 'b:2': 'acked' });
  });

  it('builds the self line from the record when the session is not a live agent', async () => {
    const { out, code } = await rerun([{ paneKey: 'b:2', behavior: acks }], { seed: seed([sent('a:1', { repo: 'api', worktree: 'me' }), sent('b:2')]), env: { ORCA_PANE_KEY: 'a:1' } });
    expect(code).toBe(0);
    expect(out).toMatch(/api\s+me\s+session\s+pending/);
  });
});

describe('re-run: lifecycle and exits', () => {
  it('closes a settled but open record on a re-run with no wait, exit 0', async () => {
    const { code, dir, out } = await rerun([{ paneKey: 'a:1', behavior: silent }], { seed: seed([sent('a:1', { status: 'acked', reason: null })]) });
    expect(code).toBe(0);
    expect((await readRecord(dir)).status).toBe('closed');
    expect(await hasPointer(dir)).toBe(false);
    expect(out).toContain('acked');
  });

  it('exits 1 when a target in scope is gone, and closes the record', async () => {
    const { code, dir } = await rerun([{ paneKey: 'a:1', behavior: acks }], { seed: seed([sent('a:1'), sent('b:2', { status: 'gone', reason: 'terminal-closed' })]) });
    expect(code).toBe(1);
    expect((await readRecord(dir)).status).toBe('closed');
  });

  it('exits 130 on a signal during a pure wait, with the record kept and the pid cleared', async () => {
    const signals = new EventEmitter();
    const clock = fakeClock();
    clock.onSleep = () => signals.emit('SIGTERM');
    const { code, dir } = await rerun([{ paneKey: 'a:1', behavior: silent }], { seed: seed([sent('a:1')], { pid: 1, startTime: '5' }), signals, clock });
    expect(code).toBe(130);
    const record = await readRecord(dir);
    expect(record.status).toBe('open');
    expect(record).not.toHaveProperty('pid');
    expect(await hasPointer(dir)).toBe(true);
  });

  it('exits 2 when Orca cannot be listed, with the targets unchanged and the pid cleared', async () => {
    const { code, dir } = await rerun([{ paneKey: 'a:1', behavior: acks }], { seed: seed([failed('a:1')], { pid: 1, startTime: '5' }), configure: (p) => (p.failListingsFrom = 1) });
    expect(code).toBe(2);
    const record = await readRecord(dir);
    expect(reasons(record)).toEqual({ 'a:1': 'send-failed' });
    expect(record).not.toHaveProperty('pid');
  });

  it('gives the full record in --json, and nothing-to-do with record null when nothing is in scope', async () => {
    const full = await run(['broadcast', '--yes', '--json'], [{ paneKey: 'a:1', behavior: acks }], { seed: seed([sent('a:1')]) });
    expect(JSON.parse(full.out)).toMatchObject({ command: 'broadcast', outcome: 'done', exitCode: 0, record: { id: 'b-1', status: 'closed' } });

    const none = await run(['broadcast', '--yes', '--json'], [{ paneKey: 'a:1', behavior: acks }], { seed: seed([sent('a:1')]), env: { ORCA_PANE_KEY: 'a:1' } });
    expect(JSON.parse(none.out)).toMatchObject({ outcome: 'nothing-to-do', exitCode: 0, record: null });
  });
});
