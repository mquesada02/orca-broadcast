import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run } from './types.js';

const POINTER = 'current';

export interface RecordStore {
  findOpenRun(): Promise<Run | null>;
  hasOpenRun(): Promise<boolean>;
  save(run: Run): Promise<void>;
  setCurrent(runId: string): Promise<void>;
  clearCurrent(): Promise<void>;
  dir: string;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function readRun(path: string): Promise<Run | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Run;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`unreadable record ${path}: ${(error as Error).message}`);
  }
}

export function createRecordStore(dir: string): RecordStore {
  const runPath = (runId: string) => join(dir, `${runId}.json`);

  return {
    dir,

    async findOpenRun() {
      let pointed: string | null = null;
      try {
        pointed = (await readFile(join(dir, POINTER), 'utf8')).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const current = pointed ? await readRun(runPath(pointed)) : null;
      if (current?.status === 'open') return current;

      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      let newest: Run | null = null;
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        const run = await readRun(join(dir, name));
        if (run?.status === 'open' && (!newest || run.startedAt > newest.startedAt)) newest = run;
      }
      return newest;
    },

    async hasOpenRun() {
      return (await this.findOpenRun()) !== null;
    },

    async save(run) {
      await mkdir(dir, { recursive: true });
      await writeAtomic(runPath(run.runId), `${JSON.stringify(run, null, 2)}\n`);
    },

    async setCurrent(runId) {
      await mkdir(dir, { recursive: true });
      await writeAtomic(join(dir, POINTER), `${runId}\n`);
    },

    async clearCurrent() {
      await rm(join(dir, POINTER), { force: true });
    },
  };
}
