import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRecordStore, type StoreOptions } from '../src/store.js';
import type { BroadcastRecord, RecoveryRecord, RecoveryRow, Run } from '../src/types.js';
import { broadcastTarget, tempStateDir } from './helpers/fake-orca.js';

const T0 = Date.parse('2026-05-01T10:00:00.000Z');
const STAMP = '2026-05-01T10:00:00.000Z';
const DEAD = 4_000_000;
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);
const noStart = () => undefined;
const newStore = (dir: string, options: StoreOptions = {}) => createRecordStore(dir, { readStartTime: noStart, now: () => T0, ...options });

const run = (runId: string, startedAt = '2026-01-01T00:00:00.000Z'): Run => ({ runId, token: '***', startedAt, status: 'open', scope: [{ typed: {} }], agents: [] });
const broadcast = (id: string, createdAt: string): BroadcastRecord => ({ id, createdAt, status: 'open', token: '***', text: 'hello', targets: [broadcastTarget('a:1')] });
const recovery = (id: string, createdAt: string): RecoveryRecord => ({
  id,
  token: '***',
  createdAt,
  status: 'open',
  snapshotKey: { bootId: 'boot-0', runtimeId: 'runtime-0' },
  liveRuntime: { bootId: 'boot-1', runtimeId: null },
  snapshots: [],
  rows: [],
});

async function withDir(files: Record<string, string> = {}) {
  const dir = await tempStateDir();
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

const fileOf = async (dir: string, folder: string, id: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(dir, folder, `${id}.json`), 'utf8')) as Record<string, unknown>;

describe('the save stamp', () => {
  it('is written to the file of each record kind and never to the caller object', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    const r = run('r1');
    const b = broadcast('b1', '2026-02-01T00:00:00.000Z');
    const c = recovery('c1', '2026-02-01T00:00:00.000Z');
    await s.save(r);
    await s.saveBroadcast(b);
    await s.saveRecovery(c);
    expect((await fileOf(dir, 'pauses', 'r1')).savedAt).toBe(STAMP);
    expect((await fileOf(dir, 'broadcasts', 'b1')).savedAt).toBe(STAMP);
    expect((await fileOf(dir, 'recoveries', 'c1')).savedAt).toBe(STAMP);
    for (const record of [r, b, c]) expect(record).not.toHaveProperty('savedAt');
  });

  it('is renewed by the next save', async () => {
    const dir = await withDir();
    let now = T0;
    const s = newStore(dir, { now: () => now });
    await s.saveBroadcast(broadcast('b1', '2026-02-01T00:00:00.000Z'));
    now = T0 + 5000;
    await s.saveBroadcast(broadcast('b1', '2026-02-01T00:00:00.000Z'));
    expect((await fileOf(dir, 'broadcasts', 'b1')).savedAt).toBe('2026-05-01T10:00:05.000Z');
  });

  it('uses the real clock when no clock is given', async () => {
    const dir = await withDir();
    await createRecordStore(dir, { readStartTime: noStart }).saveBroadcast(broadcast('b1', '2026-02-01T00:00:00.000Z'));
    expect(Date.parse((await fileOf(dir, 'broadcasts', 'b1')).savedAt as string)).toBeGreaterThan(T0);
  });

  it('is not written to a roster snapshot', async () => {
    const dir = await withDir();
    await newStore(dir).saveRoster({ bootId: 'b', runtimeId: 'r', firstSavedAt: STAMP, lastSavedAt: STAMP, entries: [] });
    expect(await fileOf(dir, 'roster', 'b-r')).not.toHaveProperty('savedAt');
  });

  it('is removed from every record a loader returns, and a record without it loads', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('r1'));
    await s.saveBroadcast(broadcast('b1', '2026-02-01T00:00:00.000Z'));
    await s.saveBroadcast(broadcast('b0', '2026-01-01T00:00:00.000Z'));
    await s.saveRecovery(recovery('c1', '2026-02-01T00:00:00.000Z'));
    await s.saveRecovery({ ...recovery('c0', '2026-01-01T00:00:00.000Z'), status: 'closed', endedBy: 'done' });
    const peeked = await s.peekOpen();
    expect(peeked.pause?.record).not.toHaveProperty('savedAt');
    expect(peeked.broadcast?.record).not.toHaveProperty('savedAt');
    expect(peeked.broadcast?.others[0]).not.toHaveProperty('savedAt');
    expect(peeked.recovery?.record).not.toHaveProperty('savedAt');
    const loaded = await s.loadOpen();
    expect(loaded.pause?.record).not.toHaveProperty('savedAt');
    expect((await s.findOpenRun())?.run).not.toHaveProperty('savedAt');
    expect(await s.loadNewestClosedRecovery()).not.toHaveProperty('savedAt');
  });

  it('keeps the per-row savedAt of a recovery row, which is another field', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    const row: RecoveryRow = { sessionId: 's1', paneKey: 'old:1', repo: 'repo', repoId: 'rp', worktree: 'tree', worktreeId: 'w', worktreePath: '/work/tree', role: 'worker', orchestrationRunIds: [], state: 'working', stateStartedAt: 1, savedAt: '2026-01-01T00:00:00.000Z', status: 'pending', reason: null, promptDue: true, messagePending: true, baseline: null };
    await s.saveRecovery({ ...recovery('c1', '2026-02-01T00:00:00.000Z'), rows: [row] });
    expect((await s.peekOpen()).recovery?.record.rows[0]?.savedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('peekWinner', () => {
  it('returns null when nothing is open, also when the state folder does not exist', async () => {
    expect(await newStore(await tempStateDir()).peekWinner()).toBeNull();
    expect(await newStore(await withDir()).peekWinner()).toBeNull();
  });

  const cases: [string, (s: ReturnType<typeof newStore>) => Promise<void>, string, string][] = [
    ['a pause run beside a broadcast', async (s) => { await s.save(run('r1')); await s.saveBroadcast(broadcast('b1', '2026-09-01T00:00:00.000Z')); }, 'pause', 'r1'],
    ['a recovery newer than a broadcast', async (s) => { await s.saveBroadcast(broadcast('b1', '2026-01-01T00:00:00.000Z')); await s.saveRecovery(recovery('c1', '2026-02-01T00:00:00.000Z')); }, 'recovery', 'c1'],
    ['a broadcast newer than a recovery', async (s) => { await s.saveBroadcast(broadcast('b1', '2026-03-01T00:00:00.000Z')); await s.saveRecovery(recovery('c1', '2026-02-01T00:00:00.000Z')); }, 'broadcast', 'b1'],
    ['a tie', async (s) => { await s.saveBroadcast(broadcast('b1', '2026-02-01T00:00:00.000Z')); await s.saveRecovery(recovery('c1', '2026-02-01T00:00:00.000Z')); }, 'recovery', 'c1'],
  ];

  it.each(cases)('picks the record the repairing load picks: %s', async (_name, seed, kind, id) => {
    const dir = await withDir();
    const s = newStore(dir);
    await seed(s);
    const winner = await s.peekWinner();
    expect(winner?.kind).toBe(kind);
    const record = winner?.record as { id?: string; runId?: string };
    expect(record.id ?? record.runId).toBe(id);
    expect(winner?.savedAt).toBe(STAMP);
    const pointer = JSON.parse(await readFile(join(dir, 'current'), 'utf8').catch(() => 'null')) as { kind: string; id: string } | null;
    expect(pointer).toBeNull();
    // The repairing load agrees, and sets the pointer to the same record.
    await s.loadOpen();
    expect(JSON.parse(await readFile(join(dir, 'current'), 'utf8'))).toEqual({ kind, id });
  });

  it('returns a null stamp for a record saved before the stamp existed', async () => {
    const dir = await withDir();
    await mkdir(join(dir, 'broadcasts'));
    await writeFile(join(dir, 'broadcasts', 'b1.json'), JSON.stringify(broadcast('b1', '2026-02-01T00:00:00.000Z')));
    expect((await newStore(dir).peekWinner())?.savedAt).toBeNull();
  });

  it('repairs nothing: the pointer and the files stay as they are, also beside a pause run', async () => {
    const dir = await withDir({ current: 'stale\n' });
    const s = newStore(dir);
    await s.save(run('r1'));
    await s.saveBroadcast(broadcast('b1', '2026-02-01T00:00:00.000Z'));
    const before = await readFile(join(dir, 'broadcasts', 'b1.json'), 'utf8');
    await s.peekWinner();
    expect(await readFile(join(dir, 'current'), 'utf8')).toBe('stale\n');
    expect(await readFile(join(dir, 'broadcasts', 'b1.json'), 'utf8')).toBe(before);
    expect((await fileOf(dir, 'broadcasts', 'b1')).status).toBe('open');
  });
});

describe('isRunning', () => {
  it('is true for a live owner with the same start time', async () => {
    const dir = await withDir({ lock: '100 5000\n' });
    expect(await newStore(dir, { isAlive: alive(100), readStartTime: () => '5000' }).isRunning()).toBe(true);
  });

  it('is false with no lock file and with an invalid one', async () => {
    expect(await newStore(await withDir()).isRunning()).toBe(false);
    expect(await newStore(await withDir({ lock: 'garbage\n' })).isRunning()).toBe(false);
  });

  it('is false for a dead owner and for a live pid with another start time', async () => {
    expect(await newStore(await withDir({ lock: `${DEAD} 5000\n` }), { isAlive: alive() }).isRunning()).toBe(false);
    expect(await newStore(await withDir({ lock: '100 5000\n' }), { isAlive: alive(100), readStartTime: () => '9999' }).isRunning()).toBe(false);
  });

  it('uses the pid alone when the lock file has no start time', async () => {
    expect(await newStore(await withDir({ lock: '100\n' }), { isAlive: alive(100), readStartTime: () => '5000' }).isRunning()).toBe(true);
    expect(await newStore(await withDir({ lock: `${DEAD}\n` }), { isAlive: alive() }).isRunning()).toBe(false);
  });

  it('uses the pid alone when the start time of the live pid cannot be read', async () => {
    expect(await newStore(await withDir({ lock: '100 5000\n' }), { isAlive: alive(100), readStartTime: noStart }).isRunning()).toBe(true);
  });

  it('takes no lock and writes nothing', async () => {
    const dir = await withDir();
    await newStore(dir).isRunning();
    await expect(readFile(join(dir, 'lock'), 'utf8')).rejects.toThrow();
  });

  it('rejects when the lock path cannot be read as a file', async () => {
    const dir = await withDir();
    await mkdir(join(dir, 'lock'));
    await expect(newStore(dir).isRunning()).rejects.toThrow();
  });
});
