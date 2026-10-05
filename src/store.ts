import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run } from './types.js';

const POINTER = 'current';

export interface RecordStore {
  hasOpenRun(): Promise<boolean>;
  save(run: Run): Promise<void>;
  setCurrent(runId: string): Promise<void>;
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

    async hasOpenRun() {
      let pointer: string | null = null;
      try {
        pointer = (await readFile(join(dir, POINTER), 'utf8')).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (pointer && (await readRun(runPath(pointer)))?.status === 'open') return true;

      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        if ((await readRun(join(dir, name)))?.status === 'open') return true;
      }
      return false;
    },

    async save(run) {
      await mkdir(dir, { recursive: true });
      await writeAtomic(runPath(run.runId), `${JSON.stringify(run, null, 2)}\n`);
    },

    async setCurrent(runId) {
      await mkdir(dir, { recursive: true });
      await writeAtomic(join(dir, POINTER), `${runId}\n`);
    },
  };
}
