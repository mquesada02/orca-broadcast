import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRecordStore } from '../src/store.js';
import type { Run } from '../src/types.js';
import { tempStateDir } from './helpers/fake-orca.js';

const run = (runId: string, startedAt: string, status: Run['status'] = 'open'): Run => ({ runId, token: 'abcd1234', startedAt, status, agents: [] });

describe('record store: find open run', () => {
  it('returns null for a missing directory and for a directory with only closed runs', async () => {
    const dir = await tempStateDir();
    const store = createRecordStore(dir);
    expect(await store.findOpenRun()).toBeNull();
    expect(await store.hasOpenRun()).toBe(false);
    await store.save(run('r1', '2026-01-01T00:00:00.000Z', 'closed'));
    expect(await store.findOpenRun()).toBeNull();
  });

  it('returns the run named by the pointer when it is open', async () => {
    const store = createRecordStore(await tempStateDir());
    await store.save(run('older', '2026-01-01T00:00:00.000Z'));
    await store.save(run('newer', '2026-02-01T00:00:00.000Z'));
    await store.setCurrent('older');
    expect((await store.findOpenRun())?.runId).toBe('older');
  });

  it('falls back to the newest open run when the pointer is missing, dangling or names a closed run', async () => {
    const store = createRecordStore(await tempStateDir());
    await store.save(run('older', '2026-01-01T00:00:00.000Z'));
    await store.save(run('newer', '2026-02-01T00:00:00.000Z'));
    await store.save(run('shut', '2026-03-01T00:00:00.000Z', 'closed'));
    expect((await store.findOpenRun())?.runId).toBe('newer');
    await store.setCurrent('ghost');
    expect((await store.findOpenRun())?.runId).toBe('newer');
    await store.setCurrent('shut');
    expect((await store.findOpenRun())?.runId).toBe('newer');
  });

  it('throws when a run file exists but cannot be parsed', async () => {
    const dir = await tempStateDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bad.json'), 'nope');
    await expect(createRecordStore(dir).findOpenRun()).rejects.toThrow(/unreadable record/);
  });
});

describe('record store: clear pointer', () => {
  it('removes the pointer and keeps the run file, and is safe when the pointer is missing', async () => {
    const dir = await tempStateDir();
    const store = createRecordStore(dir);
    await store.save(run('r1', '2026-01-01T00:00:00.000Z'));
    await store.setCurrent('r1');
    await store.clearCurrent();
    expect(await readdir(dir)).toEqual(['r1.json']);
    await expect(store.clearCurrent()).resolves.toBeUndefined();
  });
});
