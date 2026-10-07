import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BroadcastRecord } from '../../src/types.js';

/** The store folder inside the state home that `runCli` returns as `dir`. */
export const storeDir = (dir: string): string => join(dir, 'orca-broadcast');

/** Every broadcast record in the store, as saved. */
export async function readBroadcasts(dir: string): Promise<BroadcastRecord[]> {
  const folder = join(storeDir(dir), 'broadcasts');
  const names = await readdir(folder).catch(() => [] as string[]);
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(folder, n), 'utf8')) as BroadcastRecord));
}

/** Whether the `current` pointer exists. */
export const hasPointer = async (dir: string): Promise<boolean> => (await readdir(storeDir(dir)).catch(() => [] as string[])).includes('current');

/** The status of each target by pane key. */
export const statusOf = (record?: BroadcastRecord): Record<string, string> => Object.fromEntries((record?.targets ?? []).map((t) => [t.paneKey, t.status]));
