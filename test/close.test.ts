import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { close } from '../src/close.js';
import { createRecordStore } from '../src/store.js';
import type { AgentRecord, Run } from '../src/types.js';
import { agentRecord, seedOpenRun, tempStateDir } from './helpers/fake-orca.js';

async function setup(agents: AgentRecord[], extra: Partial<Run> = {}) {
  const dir = await tempStateDir();
  const store = createRecordStore(dir);
  await seedOpenRun(store, agents, extra);
  const readRun = async (id = 'run-1'): Promise<Run> => JSON.parse(await readFile(join(dir, 'pauses', `${id}.json`), 'utf8')) as Run;
  return { dir, store, readRun };
}

describe('close', () => {
  it('abandons every pending agent, closes the run, removes the pointer and exits 0', async () => {
    const { dir, store, readRun } = await setup([
      agentRecord('a:1'),
      agentRecord('b:2', { pauseStatus: 'unconfirmed', pauseReason: 'still-working' }),
    ]);

    const summary = await close(store);

    expect(summary).toMatchObject({ outcome: 'done', exitCode: 0, error: null });
    const run = await readRun();
    expect(run.status).toBe('closed');
    expect(run.agents.map((a) => a.resumeStatus)).toEqual(['abandoned', 'abandoned']);
    expect(await readdir(dir)).not.toContain('current');
    expect(summary.rows.map((a) => a.paneKey)).toEqual(['a:1', 'b:2']);
  });

  it('keeps resumed and gone agents unchanged and returns only the abandoned ones', async () => {
    const { store, readRun } = await setup([
      agentRecord('a:1', { resumeStatus: 'resumed' }),
      agentRecord('b:2', { resumeStatus: 'gone', resumeReason: 'terminal-closed' }),
      agentRecord('c:3'),
    ]);

    const summary = await close(store);

    const run = await readRun();
    expect(run.agents.map((a) => a.resumeStatus)).toEqual(['resumed', 'gone', 'abandoned']);
    expect(run.agents[1]?.resumeReason).toBe('terminal-closed');
    expect(summary.rows.map((a) => a.paneKey)).toEqual(['c:3']);
  });

  it('keeps the resumeReason of an abandoned agent', async () => {
    const { store, readRun } = await setup([agentRecord('a:1', { resumeReason: 'no-proof' })]);
    await close(store);
    expect((await readRun()).agents[0]).toMatchObject({ resumeStatus: 'abandoned', resumeReason: 'no-proof' });
  });

  it('closes a run whose agents are all resumed or gone and returns no rows', async () => {
    const { store, readRun } = await setup([agentRecord('a:1', { resumeStatus: 'resumed' })]);
    const summary = await close(store);
    expect(summary).toMatchObject({ outcome: 'done', exitCode: 0, rows: [] });
    expect((await readRun()).status).toBe('closed');
  });

  it('reports nothing to do with exit 0 when no run is open', async () => {
    const store = createRecordStore(await tempStateDir());
    expect(await close(store)).toEqual({ outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [], record: null });
  });

  it('finds the open run when the pointer is missing', async () => {
    const { store, readRun } = await setup([agentRecord('a:1')]);
    await store.clearCurrent('pause', 'run-1');
    expect((await close(store)).outcome).toBe('done');
    expect((await readRun()).status).toBe('closed');
  });

  it('finds the open run when the pointer names a closed run, and clears the pointer', async () => {
    const { dir, store, readRun } = await setup([agentRecord('a:1')]);
    await store.save({ runId: 'old', token: 'cafebabe', startedAt: '2025-01-01T00:00:00.000Z', status: 'closed', scope: [{ typed: {} }], agents: [] });
    await store.setCurrent('pause', 'old');
    expect((await close(store)).outcome).toBe('done');
    expect((await readRun()).status).toBe('closed');
    expect(await readdir(dir)).not.toContain('current');
  });

  it('closes only the newest open run when the pointer is missing and several are open', async () => {
    const { store, readRun } = await setup([agentRecord('a:1')]);
    await store.clearCurrent('pause', 'run-1');
    await store.save({ runId: 'newer', token: 'cafebabe', startedAt: '2026-02-01T00:00:00.000Z', status: 'open', scope: [{ typed: {} }], agents: [agentRecord('z:9')] });
    await close(store);
    expect((await readRun('newer')).status).toBe('closed');
    expect((await readRun('run-1')).status).toBe('open');
  });

  it('exits 2 when a record is unreadable', async () => {
    const { dir, store } = await setup([agentRecord('a:1')]);
    await writeFile(join(dir, 'pauses', 'run-1.json'), '{not json');
    const summary = await close(store);
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2, run: null });
    expect(summary.error).toContain('unreadable record');
  });

  it('exits 2 when the pointer cannot be cleared', async () => {
    const { store } = await setup([agentRecord('a:1')]);
    const failing = { ...store, clearCurrent: async () => { throw new Error('read-only'); } };
    const summary = await close(failing);
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2 });
    expect(summary.error).toContain('read-only');
  });

  it('exits 2 when the run file cannot be saved', async () => {
    const { store } = await setup([agentRecord('a:1')]);
    const failing = { ...store, save: async () => { throw new Error('disk full'); } };
    const summary = await close(failing);
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 2 });
    expect(summary.error).toContain('disk full');
  });
});

describe('safety rails', () => {
  it('exits 130 and leaves the run open and untouched when already interrupted', async () => {
    const { dir, store, readRun } = await setup([agentRecord('a:1')]);
    const summary = await close(store, AbortSignal.abort('SIGTERM'));
    expect(summary).toMatchObject({ outcome: 'error', exitCode: 130, error: 'interrupted by SIGTERM' });
    expect((await readRun()).status).toBe('open');
    expect((await readRun()).agents[0]?.resumeStatus).toBe('pending');
    expect(await readdir(dir)).toContain('current');
  });

  it('exits 130 without changing the record when the signal arrives during the lookup', async () => {
    const { store, readRun } = await setup([agentRecord('a:1')]);
    const abort = new AbortController();
    const find = store.loadOpen.bind(store);
    store.loadOpen = async () => {
      const found = await find();
      abort.abort('SIGHUP');
      return found;
    };
    expect((await close(store, abort.signal)).exitCode).toBe(130);
    expect((await readRun()).status).toBe('open');
  });
});
