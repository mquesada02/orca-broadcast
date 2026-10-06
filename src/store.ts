import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run } from './types.js';

const POINTER = 'current';
const LOCK = 'lock';
const TAKEOVER = 'lock.takeover';
const LOCK_ATTEMPTS = 3;

export class LockHeldError extends Error {
  constructor(staleFile?: string) {
    super(`another orca-broadcast is running${staleFile ? ` (if none is, delete ${staleFile})` : ''}`);
  }
}

export interface OpenRuns {
  run: Run;
  others: Run[];
}

export interface RecordStore {
  findOpenRun(): Promise<OpenRuns | null>;
  acquireLock(): Promise<() => Promise<void>>;
  save(run: Run): Promise<void>;
  setCurrent(runId: string): Promise<void>;
  clearCurrent(): Promise<void>;
  dir: string;
}

export interface StoreOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function readRun(path: string): Promise<Run | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Run;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`unreadable record ${path}: ${(error as Error).message}`);
  }
}

type Owner = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'pid'; pid: number };

async function readOwner(path: string): Promise<Owner> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  return /^\d+$/.test(text.trim()) ? { kind: 'pid', pid: Number(text.trim()) } : { kind: 'invalid' };
}

export function createRecordStore(dir: string, options: StoreOptions = {}): RecordStore {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const runPath = (runId: string) => join(dir, `${runId}.json`);
  const lockPath = join(dir, LOCK);
  const takeoverPath = join(dir, TAKEOVER);
  const pointerPath = join(dir, POINTER);

  // The PID is written to a private file first, so the lock path is never observable empty.
  async function createExclusive(path: string): Promise<boolean> {
    const tmp = `${path}.${pid}.tmp`;
    await writeFile(tmp, `${pid}\n`);
    try {
      await link(tmp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      await removeIfPresent(tmp);
    }
  }

  async function releaseIfOwned(path: string): Promise<void> {
    const owner = await readOwner(path);
    if (owner.kind === 'pid' && owner.pid === pid) await removeIfPresent(path);
  }

  // The takeover file serialises stale-lock takeover. A leftover one is never reclaimed automatically:
  // removing it would race with a contender that has just created its own.
  async function takeOver(deadPid: number): Promise<void> {
    if (!(await createExclusive(takeoverPath))) throw new LockHeldError(takeoverPath);
    try {
      const owner = await readOwner(lockPath);
      if (owner.kind === 'invalid' || (owner.kind === 'pid' && owner.pid !== deadPid)) throw new LockHeldError();
      if (owner.kind === 'pid') await removeIfPresent(lockPath);
      if (!(await createExclusive(lockPath))) throw new LockHeldError();
    } finally {
      await releaseIfOwned(takeoverPath);
    }
  }

  async function setCurrent(runId: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeAtomic(pointerPath, `${runId}\n`);
  }

  return {
    dir,
    setCurrent,

    async clearCurrent() {
      await removeIfPresent(pointerPath);
    },

    async findOpenRun() {
      let pointed: string | null = null;
      try {
        pointed = (await readFile(pointerPath, 'utf8')).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const current = pointed ? await readRun(runPath(pointed)) : null;
      if (current?.status === 'open') return { run: current, others: [] };

      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const runs = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readRun(join(dir, n))));
      const open = runs.filter((r): r is Run => r?.status === 'open').sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
      const [run, ...others] = open;
      if (!run) {
        await removeIfPresent(pointerPath);
        return null;
      }
      await setCurrent(run.runId);
      return { run, others };
    },

    async acquireLock() {
      const release = () => releaseIfOwned(lockPath);
      await mkdir(dir, { recursive: true });
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        if (await createExclusive(lockPath)) return release;
        const owner = await readOwner(lockPath);
        if (owner.kind === 'missing') continue;
        if (owner.kind === 'invalid') throw new LockHeldError(lockPath);
        if (isAlive(owner.pid)) throw new LockHeldError();
        await takeOver(owner.pid);
        return release;
      }
      throw new LockHeldError();
    },

    async save(run) {
      await mkdir(dir, { recursive: true });
      await writeAtomic(runPath(run.runId), `${JSON.stringify(run, null, 2)}\n`);
    },
  };
}
