import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BroadcastRecord, RecoveryRecord } from '../../src/types.js';

/** The store folder inside the state home that `runCli` returns as `dir`. */
export const storeDir = (dir: string): string => join(dir, 'orca-broadcast');

/** A record file's text as a record, without the store's top-level save stamp (`savedAt`, which the store's own tests check). */
export function withoutStamp<T extends { savedAt?: string }>(text: string): T {
  const record = JSON.parse(text) as T;
  delete record.savedAt;
  return record;
}

/** Every broadcast record in the store, as saved, without the save stamp. */
export async function readBroadcasts(dir: string): Promise<BroadcastRecord[]> {
  const folder = join(storeDir(dir), 'broadcasts');
  const names = await readdir(folder).catch(() => [] as string[]);
  return Promise.all(names.map(async (n) => withoutStamp<BroadcastRecord>(await readFile(join(folder, n), 'utf8'))));
}

/** Every recovery record in the store, as saved, without the save stamp (read synchronously, so a fake port can look at the disk in the middle of a run). */
export function readRecoveries(dir: string): RecoveryRecord[] {
  const folder = join(storeDir(dir), 'recoveries');
  return (existsSync(folder) ? readdirSync(folder) : []).filter((n) => n.endsWith('.json')).map((n) => withoutStamp<RecoveryRecord>(readFileSync(join(folder, n), 'utf8')));
}

/** The `current` pointer as saved, or null. */
export const readPointer = (dir: string): { kind: string; id: string } | null => {
  const path = join(storeDir(dir), 'current');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { kind: string; id: string }) : null;
};

/** Whether the `current` pointer exists. */
export const hasPointer = async (dir: string): Promise<boolean> => (await readdir(storeDir(dir)).catch(() => [] as string[])).includes('current');

/** The status of each target by pane key. */
export const statusOf = (record?: BroadcastRecord): Record<string, string> => Object.fromEntries((record?.targets ?? []).map((t) => [t.paneKey, t.status]));
