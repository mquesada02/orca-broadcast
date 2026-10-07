import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRecordStore, LockHeldError, parseProcStartTime, type StoreOptions } from '../src/store.js';
import type { BroadcastRecord, Run } from '../src/types.js';
import { tempStateDir } from './helpers/fake-orca.js';

const run = (runId: string, startedAt: string, status: Run['status'] = 'open'): Run => ({ runId, token: 'cafebabe', startedAt, status, scope: [{ typed: {} }], agents: [] });
const DEAD = 4_000_000;
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);
const noStart = () => undefined;
const starts = (table: Record<number, string>) => (pid: number) => table[pid];
const broadcast = (id: string, createdAt: string, status: BroadcastRecord['status'] = 'open'): BroadcastRecord => ({ id, createdAt, status, token: 'abcd1234', text: 'hello', targets: [] });
// Fake pids must never read the real /proc, so every store gets a reader.
const newStore = (dir: string, options: StoreOptions = {}) => createRecordStore(dir, { readStartTime: noStart, ...options });
const pointer = async (dir: string) => JSON.parse(await readFile(join(dir, 'current'), 'utf8'));

async function withDir(files: Record<string, string> = {}) {
  const dir = await tempStateDir();
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

describe('records', () => {
  it('loads a record written before run ids existed with an empty run id list', async () => {
    const old = { ...run('run-old', '2026-01-01T00:00:00.000Z'), agents: [{ paneKey: 'a:1', role: 'worker' }] };
    const dir = await withDir();
    await mkdir(join(dir, 'pauses'));
    await writeFile(join(dir, 'pauses', 'run-old.json'), JSON.stringify(old));
    const found = await createRecordStore(dir).findOpenRun();
    expect(found?.run.agents[0]?.orchestrationRunIds).toEqual([]);
  });
});

describe('lock', () => {
  it('is exclusive while its owner lives, and release makes it available again', async () => {
    const dir = await withDir();
    const a = newStore(dir, { pid: 100, isAlive: alive(100) });
    const b = newStore(dir, { pid: 200, isAlive: alive(100, 200) });
    const release = await a.acquireLock();
    await expect(b.acquireLock()).rejects.toThrow('another orca-broadcast is running');
    await expect(b.acquireLock()).rejects.toBeInstanceOf(LockHeldError);
    await release();
    expect(await readdir(dir)).toEqual([]);
    await (await b.acquireLock())();
  });

  it('creates the state directory when it does not exist', async () => {
    const dir = await tempStateDir();
    await (await newStore(dir).acquireLock())();
    expect(await readdir(dir)).toEqual([]);
  });

  it('takes over a lock whose PID is dead and leaves no takeover file behind', async () => {
    const dir = await withDir({ lock: `${DEAD}\n` });
    const store = newStore(dir, { pid: 200, isAlive: alive(200) });
    const release = await store.acquireLock();
    expect((await readFile(join(dir, 'lock'), 'utf8')).trim()).toBe('200');
    expect(await readdir(dir)).toEqual(['lock']);
    await release();
  });

  it('never takes over a lock that is empty or not a PID', async () => {
    for (const content of ['', 'garbage']) {
      const dir = await withDir({ lock: content });
      await expect(newStore(dir, { pid: 200, isAlive: alive(200) }).acquireLock()).rejects.toBeInstanceOf(LockHeldError);
      expect(await readFile(join(dir, 'lock'), 'utf8')).toBe(content);
    }
  });

  it('never reclaims a leftover takeover file and names it in the error', async () => {
    const dir = await withDir({ lock: `${DEAD}\n`, 'lock.takeover': `${DEAD}\n` });
    const store = newStore(dir, { pid: 200, isAlive: alive(200) });
    await expect(store.acquireLock()).rejects.toThrow(/another orca-broadcast is running.*lock\.takeover/);
  });

  it('gives one holder and one failure when two processes take over the same dead lock', async () => {
    for (let round = 0; round < 20; round++) {
      const dir = await withDir({ lock: `${DEAD}\n` });
      const contenders = [200, 300].map((pid) => newStore(dir, { pid, isAlive: alive(200, 300) }).acquireLock());
      const settled = await Promise.allSettled(contenders);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof LockHeldError)).toBe(true);
    }
  });

  it('release removes only a lock that still holds its own PID', async () => {
    const dir = await withDir();
    const release = await newStore(dir, { pid: 100 }).acquireLock();
    await writeFile(join(dir, 'lock'), '999\n');
    await release();
    expect((await readFile(join(dir, 'lock'), 'utf8')).trim()).toBe('999');
  });
});

describe('lock owner and start time', () => {
  it('writes <pid> <starttime>, or the pid alone when the start time is unavailable', async () => {
    for (const [startTime, content] of [['5000', '100 5000\n'], [undefined, '100\n']] as const) {
      const dir = await withDir();
      const release = await newStore(dir, { pid: 100, readStartTime: () => startTime }).acquireLock();
      expect(await readFile(join(dir, 'lock'), 'utf8')).toBe(content);
      await release();
      expect(await readdir(dir)).toEqual([]);
    }
  });

  it('reads its own start time from /proc by default', async () => {
    const dir = await withDir();
    const release = await createRecordStore(dir).acquireLock();
    expect(await readFile(join(dir, 'lock'), 'utf8')).toMatch(/^\d+ \d+\n$/);
    await release();
  });

  it('exposes its own pid and the parsed lock owner', async () => {
    const dir = await withDir();
    const a = newStore(dir, { pid: 100, readStartTime: starts({ 100: '5000' }) });
    expect(a.pid).toBe(100);
    expect(await a.lockOwner()).toBeNull();
    const release = await a.acquireLock();
    expect(await a.lockOwner()).toEqual({ pid: 100, startTime: '5000' });
    await release();
    await writeFile(join(dir, 'lock'), '300\n');
    expect(await a.lockOwner()).toEqual({ pid: 300 });
    await writeFile(join(dir, 'lock'), 'garbage');
    expect(await a.lockOwner()).toBeNull();
  });

  it('takes over a live pid whose start time differs from the recorded one (pid reuse)', async () => {
    const dir = await withDir({ lock: '100 5000\n' });
    const store = newStore(dir, { pid: 200, isAlive: alive(100, 200), readStartTime: starts({ 100: '9999', 200: '7' }) });
    const release = await store.acquireLock();
    expect(await readFile(join(dir, 'lock'), 'utf8')).toBe('200 7\n');
    expect(await readdir(dir)).toEqual(['lock']);
    await release();
  });

  it('does not take over a live pid whose start time matches', async () => {
    const dir = await withDir({ lock: '100 5000\n' });
    const store = newStore(dir, { pid: 200, isAlive: alive(100, 200), readStartTime: starts({ 100: '5000' }) });
    await expect(store.acquireLock()).rejects.toBeInstanceOf(LockHeldError);
  });

  it.each([
    ['the lock has no start time', '100\n', { 100: '5000' }],
    ['the live owner has no readable start time', '100 5000\n', {}],
  ])('falls back to the pid rule when %s', async (_name, lock, table) => {
    const dir = await withDir({ lock });
    const store = newStore(dir, { pid: 200, isAlive: alive(100, 200), readStartTime: starts(table) });
    await expect(store.acquireLock()).rejects.toBeInstanceOf(LockHeldError);
  });

  it('still takes over a dead pid that has a recorded start time', async () => {
    const dir = await withDir({ lock: `${DEAD} 5000\n` });
    await (await newStore(dir, { pid: 200, isAlive: alive(200) }).acquireLock())();
  });

  it.each([
    ['another pid', `${DEAD} 5000\n`, '300 7\n'],
    ['a start time that was absent', `${DEAD}\n`, `${DEAD} 7\n`],
    ['an invalid lock', `${DEAD}\n`, 'garbage'],
  ])('fails the takeover re-check when the lock changed to %s', async (_name, before, after) => {
    const dir = await withDir({ lock: before });
    const isAlive = (pid: number) => {
      if (pid === DEAD) writeFileSync(join(dir, 'lock'), after);
      return pid === 200;
    };
    await expect(newStore(dir, { pid: 200, isAlive }).acquireLock()).rejects.toBeInstanceOf(LockHeldError);
    expect(await readFile(join(dir, 'lock'), 'utf8')).toBe(after);
    expect(await readdir(dir)).toEqual(['lock']);
  });

  it('fails the takeover re-check when the same pid now has another start time', async () => {
    const dir = await withDir({ lock: '100 5000\n' });
    const readStartTime = (pid: number) => {
      if (pid !== 100) return undefined;
      writeFileSync(join(dir, 'lock'), '100 6000\n');
      return '9999';
    };
    await expect(newStore(dir, { pid: 200, isAlive: alive(100, 200), readStartTime }).acquireLock()).rejects.toBeInstanceOf(LockHeldError);
  });

  it('allows a takeover when the lock vanished before the re-check', async () => {
    const dir = await withDir({ lock: `${DEAD}\n` });
    const isAlive = (pid: number) => {
      if (pid === DEAD) rmSync(join(dir, 'lock'));
      return pid === 200;
    };
    await (await newStore(dir, { pid: 200, isAlive }).acquireLock())();
  });

  it('release keeps a lock that names the same pid with another start time', async () => {
    const dir = await withDir();
    const release = await newStore(dir, { pid: 100, readStartTime: starts({ 100: '5000' }) }).acquireLock();
    await writeFile(join(dir, 'lock'), '100 6000\n');
    await release();
    expect(await readFile(join(dir, 'lock'), 'utf8')).toBe('100 6000\n');
  });
});

describe('parseProcStartTime', () => {
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

  it('reads field 22 from a real stat line', () => {
    expect(parseProcStartTime(fixture('proc-stat.txt'))).toBe('3601991');
  });

  it('reads field 22 when the command name contains spaces and parentheses', () => {
    expect(parseProcStartTime(fixture('proc-stat-odd-name.txt'))).toBe('3601991');
  });

  it.each([['empty', ''], ['truncated', '1 (x) R 1 1'], ['no parenthesis', 'garbage'], ['not a number', fixture('proc-stat.txt').replace('3601991', 'abc')]])('gives no start time for %s input', (_name, text) => {
    expect(parseProcStartTime(text)).toBeUndefined();
  });
});

describe('layout and pointer', () => {
  it('keeps pause runs in pauses/ and broadcast records in broadcasts/, and nothing as a record in the root', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('r1', '2026-01-01T00:00:00.000Z'));
    await s.saveBroadcast(broadcast('b1', '2026-01-01T00:00:00.000Z'));
    expect((await readdir(dir)).sort()).toEqual(['broadcasts', 'pauses']);
    expect(await readdir(join(dir, 'pauses'))).toEqual(['r1.json']);
    expect(await readdir(join(dir, 'broadcasts'))).toEqual(['b1.json']);
  });

  it('creates no record folder until a record is saved', async () => {
    const dir = await tempStateDir();
    const s = newStore(dir);
    await s.loadOpen();
    await s.peekOpen();
    await (await s.acquireLock())();
    expect(await readdir(dir)).toEqual([]);
  });

  it('writes the pointer as {kind, id} JSON for both kinds', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.setCurrent('pause', 'r1');
    expect(await pointer(dir)).toEqual({ kind: 'pause', id: 'r1' });
    await s.setCurrent('broadcast', 'b1');
    expect(await pointer(dir)).toEqual({ kind: 'broadcast', id: 'b1' });
  });

  it('clears the pointer only when it names that record, and is safe when it is missing', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.setCurrent('pause', 'r1');
    await s.clearCurrent('pause', 'other');
    await s.clearCurrent('broadcast', 'r1');
    expect(await pointer(dir)).toEqual({ kind: 'pause', id: 'r1' });
    await s.clearCurrent('pause', 'r1');
    expect(await readdir(dir)).toEqual([]);
    await expect(s.clearCurrent('pause', 'r1')).resolves.toBeUndefined();
  });

  it('removes a run file and clears the pointer when it names that run', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('r1', '2026-01-01T00:00:00.000Z'));
    await s.setCurrent('pause', 'r1');
    await s.removeRun('r1');
    expect(await readdir(dir)).toEqual(['pauses']);
    expect(await readdir(join(dir, 'pauses'))).toEqual([]);
    await expect(s.removeRun('r1')).resolves.toBeUndefined();
  });

  it('removes a run but keeps a pointer that names another record', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('r1', '2026-01-01T00:00:00.000Z'));
    await s.save(run('r2', '2026-02-01T00:00:00.000Z'));
    await s.setCurrent('pause', 'r2');
    await s.removeRun('r1');
    expect(await readdir(join(dir, 'pauses'))).toEqual(['r2.json']);
    expect(await pointer(dir)).toEqual({ kind: 'pause', id: 'r2' });
  });

  it('leaves only complete record files and no temporary file', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('r1', '2026-01-01T00:00:00.000Z'));
    await s.save({ ...run('r1', '2026-01-01T00:00:00.000Z'), status: 'closed' });
    await s.saveBroadcast(broadcast('b1', '2026-01-01T00:00:00.000Z'));
    await s.saveBroadcast(broadcast('b1', '2026-01-01T00:00:00.000Z', 'closed'));
    expect(await readdir(join(dir, 'pauses'))).toEqual(['r1.json']);
    expect(await readdir(join(dir, 'broadcasts'))).toEqual(['b1.json']);
    expect(JSON.parse(await readFile(join(dir, 'pauses', 'r1.json'), 'utf8')).status).toBe('closed');
    expect(JSON.parse(await readFile(join(dir, 'broadcasts', 'b1.json'), 'utf8')).status).toBe('closed');
  });
});

describe('open-record scan', () => {
  it('returns nothing for a missing state directory', async () => {
    const s = newStore(await tempStateDir());
    expect(await s.findOpenRun()).toBeNull();
    expect(await s.loadOpen()).toEqual({ pause: null, broadcast: null });
    expect(await s.peekOpen()).toEqual({ pause: null, broadcast: null });
  });

  it('recovers an open run when the pointer is missing and repairs the pointer', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('r1', '2026-01-01T00:00:00.000Z'));
    expect((await s.findOpenRun())?.run.runId).toBe('r1');
    expect(await pointer(dir)).toEqual({ kind: 'pause', id: 'r1' });
  });

  it.each([['names a closed run', 'closed-run'], ['names a missing run', 'ghost']])('recovers the open run when the pointer %s', async (_name, id) => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('closed-run', '2026-02-01T00:00:00.000Z', 'closed'));
    await s.save(run('open-run', '2026-01-01T00:00:00.000Z'));
    await s.setCurrent('pause', id);
    expect((await s.findOpenRun())?.run.runId).toBe('open-run');
    expect(await pointer(dir)).toEqual({ kind: 'pause', id: 'open-run' });
  });

  it('scans even when the pointer is valid: the newest open run wins, the others are reported and the pointer is reset', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('old', '2026-01-01T00:00:00.000Z'));
    await s.save(run('new', '2026-02-01T00:00:00.000Z'));
    await s.setCurrent('pause', 'old');
    const found = await s.findOpenRun();
    expect(found?.run.runId).toBe('new');
    expect(found?.others.map((r) => r.runId)).toEqual(['old']);
    expect(await pointer(dir)).toEqual({ kind: 'pause', id: 'new' });
  });

  it('lists the other open runs newest first, breaking a tie on the id', async () => {
    const s = newStore(await withDir());
    await s.save(run('old', '2026-01-01T00:00:00.000Z'));
    await s.save(run('new', '2026-03-01T00:00:00.000Z'));
    await s.save(run('mid-a', '2026-02-01T00:00:00.000Z'));
    await s.save(run('mid-b', '2026-02-01T00:00:00.000Z'));
    const found = await s.findOpenRun();
    expect(found?.run.runId).toBe('new');
    expect(found?.others.map((r) => r.runId)).toEqual(['mid-b', 'mid-a', 'old']);
  });

  it('ranks open broadcasts the same way, by creation time', async () => {
    const s = newStore(await withDir());
    await s.saveBroadcast(broadcast('old', '2026-01-01T00:00:00.000Z'));
    await s.saveBroadcast(broadcast('new', '2026-02-01T00:00:00.000Z'));
    await s.saveBroadcast(broadcast('done', '2026-03-01T00:00:00.000Z', 'closed'));
    const { broadcast: found, pause } = await s.loadOpen();
    expect(pause).toBeNull();
    expect(found?.record.id).toBe('new');
    expect(found?.others.map((r) => r.id)).toEqual(['old']);
  });

  it('gives no open run for an open broadcast alone, and points at the broadcast', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.saveBroadcast(broadcast('b1', '2026-01-01T00:00:00.000Z'));
    expect(await s.findOpenRun()).toBeNull();
    expect(await pointer(dir)).toEqual({ kind: 'broadcast', id: 'b1' });
  });

  it('reports both kinds when both are open and gives the pointer to the pause run, without changing the broadcast', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.saveBroadcast(broadcast('b1', '2026-03-01T00:00:00.000Z'));
    await s.save(run('r1', '2026-01-01T00:00:00.000Z'));
    await s.setCurrent('broadcast', 'b1');
    const open = await s.loadOpen();
    expect(open.pause?.record.runId).toBe('r1');
    expect(open.broadcast?.record.id).toBe('b1');
    expect(await pointer(dir)).toEqual({ kind: 'pause', id: 'r1' });
    expect(JSON.parse(await readFile(join(dir, 'broadcasts', 'b1.json'), 'utf8')).status).toBe('open');
  });

  it('breaks a tie between open broadcasts on the id', async () => {
    const s = newStore(await withDir());
    await s.saveBroadcast(broadcast('a', '2026-01-01T00:00:00.000Z'));
    await s.saveBroadcast(broadcast('b', '2026-01-01T00:00:00.000Z'));
    const found = (await s.loadOpen()).broadcast;
    expect(found?.record.id).toBe('b');
    expect(found?.others.map((r) => r.id)).toEqual(['a']);
  });

  it('resets a pointer that has the winner\'s id but the other kind', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('x', '2026-01-01T00:00:00.000Z'));
    await s.setCurrent('broadcast', 'x');
    await s.loadOpen();
    expect(await pointer(dir)).toEqual({ kind: 'pause', id: 'x' });
  });

  it('keeps a pointer that already names the winner', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.saveBroadcast(broadcast('b1', '2026-01-01T00:00:00.000Z'));
    await s.setCurrent('broadcast', 'b1');
    const past = new Date('2020-01-01T00:00:00.000Z');
    await utimes(join(dir, 'current'), past, past);
    await s.loadOpen();
    expect((await stat(join(dir, 'current'))).mtime).toEqual(past);
  });

  it('removes a pointer when nothing is open', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    await s.save(run('done', '2026-01-01T00:00:00.000Z', 'closed'));
    await s.setCurrent('pause', 'done');
    expect(await s.findOpenRun()).toBeNull();
    expect(await readdir(dir)).toEqual(['pauses']);
  });

  it.each([
    ['plain text', 'r1\n'],
    ['invalid JSON', '{'],
    ['an unknown kind', '{"kind":"other","id":"r1"}'],
    ['a non-string id', '{"kind":"pause","id":1}'],
  ])('treats a pointer holding %s as missing and resets it', async (_name, content) => {
    const dir = await withDir({ current: content });
    const s = newStore(dir);
    await s.save(run('r1', '2026-01-01T00:00:00.000Z'));
    expect((await s.findOpenRun())?.run.runId).toBe('r1');
    expect(await pointer(dir)).toEqual({ kind: 'pause', id: 'r1' });
  });

  it('ignores records left in the old flat layout', async () => {
    const dir = await withDir({ 'old-run.json': JSON.stringify(run('old-run', '2026-01-01T00:00:00.000Z')), current: 'old-run\n' });
    const s = newStore(dir);
    expect(await s.loadOpen()).toEqual({ pause: null, broadcast: null });
    expect(await readdir(dir)).toEqual(['old-run.json']);
  });

  it('fails naming the file when a record is unreadable, and ignores leftover temporary files', async () => {
    const dir = await withDir();
    await mkdir(join(dir, 'pauses'));
    await writeFile(join(dir, 'pauses', 'half.json.tmp'), '{"runId":');
    expect(await newStore(dir).findOpenRun()).toBeNull();
    await writeFile(join(dir, 'pauses', 'bad.json'), '{"runId":');
    await expect(newStore(dir).findOpenRun()).rejects.toThrow(/unreadable record .*bad\.json/);
    await expect(newStore(dir).peekOpen()).rejects.toThrow(/unreadable record .*bad\.json/);
    await mkdir(join(dir, 'broadcasts'));
    await writeFile(join(dir, 'pauses', 'bad.json'), JSON.stringify(run('ok', '2026-01-01T00:00:00.000Z', 'closed')));
    await writeFile(join(dir, 'broadcasts', 'bad.json'), '{');
    await expect(newStore(dir).loadOpen()).rejects.toThrow(/unreadable record .*broadcasts.*bad\.json/);
  });

  it('peekOpen applies the same rule and repairs nothing', async () => {
    const dir = await withDir({ current: 'stale\n' });
    const s = newStore(dir);
    await s.save(run('r1', '2026-01-01T00:00:00.000Z'));
    await s.saveBroadcast(broadcast('b1', '2026-02-01T00:00:00.000Z'));
    const open = await s.peekOpen();
    expect(open.pause?.record.runId).toBe('r1');
    expect(open.broadcast?.record.id).toBe('b1');
    expect(await readFile(join(dir, 'current'), 'utf8')).toBe('stale\n');
    await rm(join(dir, 'current'));
    await s.peekOpen();
    expect((await readdir(dir)).sort()).toEqual(['broadcasts', 'pauses']);
  });
});

describe('own process identity and the full broadcast record', () => {
  it('exposes the start time of its own pid, read through the injected reader, and undefined when it cannot be read', async () => {
    const dir = await withDir();
    expect(newStore(dir, { pid: 100, readStartTime: starts({ 100: '5000' }) }).startTime).toBe('5000');
    expect(newStore(dir, { pid: 100 }).startTime).toBeUndefined();
  });

  it('round-trips every field of a broadcast record, targets included', async () => {
    const dir = await withDir();
    const s = newStore(dir);
    const record: BroadcastRecord = {
      ...broadcast('b1', '2026-01-01T00:00:00.000Z'),
      pid: 100,
      startTime: '5000',
      targets: [
        { paneKey: 'a:1', repoId: 'r', repo: 'repo', worktreeId: 'w', worktreePath: '/work/w', worktree: 'tree', role: 'coordinator', orchestrationRunIds: ['run_1'], lastHandle: 'term_1', baseline: null, messagePending: true, status: 'pending', reason: 'send-failed' },
      ],
    };
    await s.saveBroadcast(record);
    expect((await s.peekOpen()).broadcast?.record).toEqual(record);
  });
});
