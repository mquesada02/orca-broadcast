import { readFileSync } from 'node:fs';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseBroadcast } from './shared.js';
import type { BroadcastReason, BroadcastRecord, BroadcastTarget, Run } from './types.js';

const POINTER = 'current';
const LOCK = 'lock';
const TAKEOVER = 'lock.takeover';
const PAUSES = 'pauses';
const BROADCASTS = 'broadcasts';
const LOCK_ATTEMPTS = 3;

export class LockHeldError extends Error {
  constructor(staleFile?: string) {
    super(`another orca-broadcast is running${staleFile ? ` (if none is, delete ${staleFile})` : ''}`);
  }
}

export type RecordKind = 'pause' | 'broadcast';

export interface Pointer {
  kind: RecordKind;
  id: string;
}

export interface OpenRuns {
  run: Run;
  others: Run[];
}

export interface OpenEntry<T> {
  record: T;
  others: T[];
}

// The open winner of each kind, or null when none is open.
export interface OpenRecords {
  pause: OpenEntry<Run> | null;
  broadcast: OpenEntry<BroadcastRecord> | null;
}

// What the repairing load returns: the records after recovery, and one line per thing it found or fixed.
export interface LoadedRecords extends OpenRecords {
  notes: string[];
}

export interface LockOwner {
  pid: number;
  startTime?: string;
}

export interface RecordStore {
  /** The open pause run, as the repairing load sees it. */
  findOpenRun(): Promise<OpenRuns | null>;
  /** Scans both kinds, repairs the pointer and abandons a broadcast that is open beside a pause run. The caller must hold the lock. */
  loadOpen(): Promise<LoadedRecords>;
  /** The same selection as `loadOpen`, with no repair; safe without the lock. */
  peekOpen(): Promise<OpenRecords>;
  acquireLock(): Promise<() => Promise<void>>;
  /** The parsed lock owner, or null when there is no lock or it is invalid. */
  lockOwner(): Promise<LockOwner | null>;
  /** Whether a process with this pid exists (the reader the stale-lock rule uses). */
  isProcessAlive(pid: number): boolean;
  /** The start time of any process, when it can be read (the reader the stale-lock rule uses). */
  processStartTime(pid: number): string | undefined;
  save(run: Run): Promise<void>;
  saveBroadcast(record: BroadcastRecord): Promise<void>;
  /** Removes a pause run's file and clears the pointer if it names that run. The caller guarantees the run is new and unconfirmed. */
  removeRun(runId: string): Promise<void>;
  setCurrent(kind: RecordKind, id: string): Promise<void>;
  /** Clears the pointer only when it names this record. */
  clearCurrent(kind: RecordKind, id: string): Promise<void>;
  dir: string;
  pid: number;
  /** Start time of this process, when it can be read. */
  startTime: string | undefined;
}

export interface StoreOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  readStartTime?: (pid: number) => string | undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Field 22 of /proc/<pid>/stat is the 20th token after the last ')': the command name may contain spaces and parentheses.
export function parseProcStartTime(stat: string): string | undefined {
  const token = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  return token !== undefined && /^\d+$/.test(token) ? token : undefined;
}

function procStartTime(pid: number): string | undefined {
  try {
    return parseProcStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

// Abandons the pending targets (all, or those `select` picks) of a broadcast that nobody runs any more: the record drops its pid and closes when nothing is pending.
export function abandonPending(record: BroadcastRecord, reason: Extract<BroadcastReason, 'paused' | 'closed'>, select: (target: BroadcastTarget) => boolean = () => true): number {
  const pending = record.targets.filter((t) => t.status === 'pending' && select(t));
  for (const target of pending) {
    target.status = 'abandoned';
    target.reason = reason;
  }
  releaseBroadcast(record); // this closes the record when nothing is pending now
  return pending.length;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function writeRecord(folder: string, id: string, record: Run | BroadcastRecord): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeAtomic(join(folder, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

async function readRecord<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`unreadable record ${path}: ${(error as Error).message}`);
  }
}

// A record written before run ids existed has none.
function backfillRunIds(run: Run): void {
  for (const agent of run.agents) agent.orchestrationRunIds ??= [];
}

// A broadcast record in the older three-field shape has no targets: it has nothing pending.
function backfillTargets(record: BroadcastRecord): void {
  record.targets ??= [];
}

// A missing folder counts as empty.
async function readOpen<T extends { status: string }>(folder: string, sortKey: (record: T) => string, idOf: (record: T) => string, normalise: (record: T) => void = () => {}): Promise<OpenEntry<T> | null> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const records: (T | null)[] = await Promise.all<T | null>(names.filter((n) => n.endsWith('.json')).map((n) => readRecord<T>(join(folder, n))));
  const open = records.filter((r): r is T => r?.status === 'open');
  open.forEach(normalise);
  open.sort((a, b) => sortKey(b).localeCompare(sortKey(a)) || idOf(b).localeCompare(idOf(a)));
  const [record, ...others] = open;
  return record ? { record, others } : null;
}

type Owner = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'owner'; owner: LockOwner };

async function readOwner(path: string): Promise<Owner> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const match = /^(\d+)(?: (\d+))?$/.exec(text.trim());
  if (!match) return { kind: 'invalid' };
  return { kind: 'owner', owner: match[2] === undefined ? { pid: Number(match[1]) } : { pid: Number(match[1]), startTime: match[2] } };
}

export function createRecordStore(dir: string, options: StoreOptions = {}): RecordStore {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const readStartTime = options.readStartTime ?? procStartTime;
  const pausesDir = join(dir, PAUSES);
  const broadcastsDir = join(dir, BROADCASTS);
  const lockPath = join(dir, LOCK);
  const takeoverPath = join(dir, TAKEOVER);
  const pointerPath = join(dir, POINTER);

  // The content is written to a private file first, so the lock path is never observable empty.
  async function createExclusive(path: string, content: string): Promise<boolean> {
    const tmp = `${path}.${pid}.tmp`;
    await writeFile(tmp, content);
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

  async function releaseIfOwned(path: string, startTime?: string): Promise<void> {
    const owner = await readOwner(path);
    if (owner.kind === 'owner' && owner.owner.pid === pid && owner.owner.startTime === startTime) await removeIfPresent(path);
  }

  // A dead pid, or a live pid whose start time differs from the recorded one (pid reuse), is stale.
  // When either start time is missing, only the pid rule applies.
  function isStale(owner: LockOwner): boolean {
    if (!isAlive(owner.pid)) return true;
    const current = owner.startTime === undefined ? undefined : readStartTime(owner.pid);
    return current !== undefined && current !== owner.startTime;
  }

  // The takeover file serialises stale-lock takeover. A leftover one is never reclaimed automatically:
  // removing it would race with a contender that has just created its own. It holds the pid only.
  async function takeOver(observed: LockOwner, content: string): Promise<void> {
    if (!(await createExclusive(takeoverPath, `${pid}\n`))) throw new LockHeldError(takeoverPath);
    try {
      const owner = await readOwner(lockPath);
      if (owner.kind === 'invalid' || (owner.kind === 'owner' && (owner.owner.pid !== observed.pid || owner.owner.startTime !== observed.startTime))) throw new LockHeldError();
      if (owner.kind === 'owner') await removeIfPresent(lockPath);
      if (!(await createExclusive(lockPath, content))) throw new LockHeldError();
    } finally {
      await releaseIfOwned(takeoverPath);
    }
  }

  async function setCurrent(kind: RecordKind, id: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeAtomic(pointerPath, `${JSON.stringify({ kind, id })}\n`);
  }

  // Anything but pointer JSON (including a pointer in the old plain-text layout) counts as missing.
  async function readPointer(): Promise<Pointer | null> {
    let text: string;
    try {
      text = await readFile(pointerPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const value = JSON.parse(text) as { kind?: unknown; id?: unknown };
      return (value.kind === 'pause' || value.kind === 'broadcast') && typeof value.id === 'string' ? { kind: value.kind, id: value.id } : null;
    } catch {
      return null;
    }
  }

  async function clearCurrent(kind: RecordKind, id: string): Promise<void> {
    const pointer = await readPointer();
    if (pointer?.kind === kind && pointer.id === id) await removeIfPresent(pointerPath);
  }

  async function peekOpen(): Promise<OpenRecords> {
    const [pause, broadcast] = await Promise.all([
      readOpen<Run>(pausesDir, (r) => r.startedAt, (r) => r.runId, backfillRunIds),
      readOpen<BroadcastRecord>(broadcastsDir, (r) => r.createdAt, (r) => r.id, backfillTargets),
    ]);
    return { pause, broadcast };
  }

  async function loadOpen(): Promise<LoadedRecords> {
    const open = await peekOpen();
    const notes: string[] = [];
    // When several records of one kind are open the newest wins and the others are only reported.
    if (open.pause?.others.length) notes.push(`other pause runs are open and were left as they are: ${open.pause.others.map((r) => r.runId).join(', ')}`);
    if (!open.pause && open.broadcast?.others.length) notes.push(`other broadcasts are open and were left as they are: ${open.broadcast.others.map((r) => r.id).join(', ')}`);
    // An open pause run wins the pointer, and every broadcast open beside it is abandoned: one record is open at a time.
    if (open.pause && open.broadcast) {
      for (const record of [open.broadcast.record, ...open.broadcast.others]) {
        abandonPending(record, 'paused');
        await writeRecord(broadcastsDir, record.id, record);
        notes.push(`broadcast ${record.id} was open beside a pause run and is now abandoned`);
      }
      open.broadcast = null;
    }
    const winner: Pointer | null = open.pause
      ? { kind: 'pause', id: open.pause.record.runId }
      : open.broadcast
        ? { kind: 'broadcast', id: open.broadcast.record.id }
        : null;
    if (!winner) {
      await removeIfPresent(pointerPath);
    } else {
      const pointer = await readPointer();
      if (pointer?.kind !== winner.kind || pointer.id !== winner.id) await setCurrent(winner.kind, winner.id);
    }
    return { ...open, notes };
  }

  return {
    dir,
    pid,
    get startTime() {
      return readStartTime(pid);
    },
    setCurrent,
    clearCurrent,
    loadOpen,
    peekOpen,

    async findOpenRun() {
      const { pause } = await loadOpen();
      return pause ? { run: pause.record, others: pause.others } : null;
    },

    isProcessAlive: isAlive,
    processStartTime: readStartTime,

    async lockOwner() {
      const owner = await readOwner(lockPath);
      return owner.kind === 'owner' ? owner.owner : null;
    },

    async acquireLock() {
      await mkdir(dir, { recursive: true });
      const startTime = readStartTime(pid);
      const content = `${pid}${startTime === undefined ? '' : ` ${startTime}`}\n`;
      const release = () => releaseIfOwned(lockPath, startTime);
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        if (await createExclusive(lockPath, content)) return release;
        const owner = await readOwner(lockPath);
        if (owner.kind === 'missing') continue;
        if (owner.kind === 'invalid') throw new LockHeldError(lockPath);
        if (!isStale(owner.owner)) throw new LockHeldError();
        await takeOver(owner.owner, content);
        return release;
      }
      throw new LockHeldError();
    },

    save: (run) => writeRecord(pausesDir, run.runId, run),

    saveBroadcast: (record) => writeRecord(broadcastsDir, record.id, record),

    async removeRun(runId) {
      await removeIfPresent(join(pausesDir, `${runId}.json`));
      await clearCurrent('pause', runId);
    },
  };
}
