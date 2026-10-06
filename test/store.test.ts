import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRecordStore, LockHeldError } from '../src/store.js';
import type { Run } from '../src/types.js';
import { tempStateDir } from './helpers/fake-orca.js';

const run = (runId: string, startedAt: string, status: Run['status'] = 'open'): Run => ({ runId, token: 'cafebabe', startedAt, status, agents: [] });
const DEAD = 4_000_000;
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);

async function withDir(files: Record<string, string> = {}) {
  const dir = await tempStateDir();
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

describe('lock', () => {
  it('is exclusive while its owner lives, and release makes it available again', async () => {
    const dir = await withDir();
    const a = createRecordStore(dir, { pid: 100, isAlive: alive(100) });
    const b = createRecordStore(dir, { pid: 200, isAlive: alive(100, 200) });
    const release = await a.acquireLock();
    await expect(b.acquireLock()).rejects.toThrow('another orca-broadcast is running');
    await expect(b.acquireLock()).rejects.toBeInstanceOf(LockHeldError);
    await release();
    expect(await readdir(dir)).toEqual([]);
    await (await b.acquireLock())();
  });

  it('creates the state directory when it does not exist', async () => {
    const dir = await tempStateDir();
    await (await createRecordStore(dir).acquireLock())();
    expect(await readdir(dir)).toEqual([]);
  });

  it('takes over a lock whose PID is dead and leaves no takeover file behind', async () => {
    const dir = await withDir({ lock: `${DEAD}\n` });
    const store = createRecordStore(dir, { pid: 200, isAlive: alive(200) });
    const release = await store.acquireLock();
    expect((await readFile(join(dir, 'lock'), 'utf8')).trim()).toBe('200');
    expect(await readdir(dir)).toEqual(['lock']);
    await release();
  });

  it('never takes over a lock that is empty or not a PID', async () => {
    for (const content of ['', 'garbage']) {
      const dir = await withDir({ lock: content });
      await expect(createRecordStore(dir, { pid: 200, isAlive: alive(200) }).acquireLock()).rejects.toBeInstanceOf(LockHeldError);
      expect(await readFile(join(dir, 'lock'), 'utf8')).toBe(content);
    }
  });

  it('never reclaims a leftover takeover file and names it in the error', async () => {
    const dir = await withDir({ lock: `${DEAD}\n`, 'lock.takeover': `${DEAD}\n` });
    const store = createRecordStore(dir, { pid: 200, isAlive: alive(200) });
    await expect(store.acquireLock()).rejects.toThrow(/another orca-broadcast is running.*lock\.takeover/);
  });

  it('gives one holder and one failure when two processes take over the same dead lock', async () => {
    for (let round = 0; round < 20; round++) {
      const dir = await withDir({ lock: `${DEAD}\n` });
      const contenders = [200, 300].map((pid) => createRecordStore(dir, { pid, isAlive: alive(200, 300) }).acquireLock());
      const settled = await Promise.allSettled(contenders);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof LockHeldError)).toBe(true);
    }
  });

  it('release removes only a lock that still holds its own PID', async () => {
    const dir = await withDir();
    const release = await createRecordStore(dir, { pid: 100 }).acquireLock();
    await writeFile(join(dir, 'lock'), '999\n');
    await release();
    expect((await readFile(join(dir, 'lock'), 'utf8')).trim()).toBe('999');
  });

  it('is never read as a run', async () => {
    const dir = await withDir({ lock: '100\n', 'lock.takeover': '100\n' });
    expect(await createRecordStore(dir).findOpenRun()).toBeNull();
  });
});

describe('open-run lookup', () => {
  it('returns null for a missing state directory', async () => {
    expect(await createRecordStore(await tempStateDir()).findOpenRun()).toBeNull();
  });

  it('recovers an open run when the pointer is missing and repairs the pointer', async () => {
    const dir = await withDir();
    const store = createRecordStore(dir);
    await store.save(run('r1', '2026-01-01T00:00:00.000Z'));
    expect((await store.findOpenRun())?.run.runId).toBe('r1');
    expect((await readFile(join(dir, 'current'), 'utf8')).trim()).toBe('r1');
  });

  it.each([['names a closed run', 'closed-run'], ['names a missing run', 'ghost']])('recovers the open run when the pointer %s', async (_name, pointer) => {
    const dir = await withDir();
    const store = createRecordStore(dir);
    await store.save(run('closed-run', '2026-02-01T00:00:00.000Z', 'closed'));
    await store.save(run('open-run', '2026-01-01T00:00:00.000Z'));
    await store.setCurrent(pointer);
    expect((await store.findOpenRun())?.run.runId).toBe('open-run');
    expect((await readFile(join(dir, 'current'), 'utf8')).trim()).toBe('open-run');
  });

  it('returns the run named by the pointer when it is open, even if a newer run is open', async () => {
    const store = createRecordStore(await withDir());
    await store.save(run('old', '2026-01-01T00:00:00.000Z'));
    await store.save(run('new', '2026-02-01T00:00:00.000Z'));
    await store.setCurrent('old');
    const found = await store.findOpenRun();
    expect(found?.run.runId).toBe('old');
    expect(found?.others).toEqual([]);
  });

  it('falls back to the newest open run and lists the others when the pointer is not usable', async () => {
    const dir = await withDir();
    const store = createRecordStore(dir);
    await store.save(run('old', '2026-01-01T00:00:00.000Z'));
    await store.save(run('new', '2026-03-01T00:00:00.000Z'));
    await store.save(run('mid', '2026-02-01T00:00:00.000Z'));
    const found = await store.findOpenRun();
    expect(found?.run.runId).toBe('new');
    expect(found?.others.map((r) => r.runId)).toEqual(['mid', 'old']);
  });

  it('removes a pointer when no run is open', async () => {
    const dir = await withDir();
    const store = createRecordStore(dir);
    await store.save(run('done', '2026-01-01T00:00:00.000Z', 'closed'));
    await store.setCurrent('done');
    expect(await store.findOpenRun()).toBeNull();
    expect(await readdir(dir)).toEqual(['done.json']);
  });

  it('fails naming the file when a record is unreadable, and ignores leftover temporary files', async () => {
    const dir = await withDir({ 'half.json.tmp': '{"runId":' });
    expect(await createRecordStore(dir).findOpenRun()).toBeNull();
    await writeFile(join(dir, 'bad.json'), '{"runId":');
    await expect(createRecordStore(dir).findOpenRun()).rejects.toThrow(/unreadable record .*bad\.json/);
  });
});

describe('clear pointer', () => {
  it('removes the pointer and keeps the run file, and is safe when the pointer is missing', async () => {
    const dir = await withDir();
    const store = createRecordStore(dir);
    await store.save(run('r1', '2026-01-01T00:00:00.000Z'));
    await store.setCurrent('r1');
    await store.clearCurrent();
    expect(await readdir(dir)).toEqual(['r1.json']);
    await expect(store.clearCurrent()).resolves.toBeUndefined();
  });
});

describe('atomic write', () => {
  it('leaves only complete run files and no temporary file', async () => {
    const dir = await withDir();
    const store = createRecordStore(dir);
    await store.save(run('r1', '2026-01-01T00:00:00.000Z'));
    await store.save({ ...run('r1', '2026-01-01T00:00:00.000Z'), status: 'closed' });
    expect(await readdir(dir)).toEqual(['r1.json']);
    expect(JSON.parse(await readFile(join(dir, 'r1.json'), 'utf8')).status).toBe('closed');
  });
});
