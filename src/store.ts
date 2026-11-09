import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { abandonRecovery } from './recover-record.js';
import { releaseBroadcast } from './shared.js';
import type { BroadcastReason, BroadcastRecord, BroadcastTarget, RecoveryRecord, RosterSnapshot, Run } from './types.js';

const POINTER = 'current';
const LOCK = 'lock';
const TAKEOVER = 'lock.takeover';
const PAUSES = 'pauses';
const BROADCASTS = 'broadcasts';
const RECOVERIES = 'recoveries';
const ROSTER = 'roster';
const LOCK_ATTEMPTS = 3;

export class LockHeldError extends Error {
  constructor(staleFile?: string) {
    super(`another orca-broadcast is running${staleFile ? ` (if none is, delete ${staleFile})` : ''}`);
  }
}

export type RecordKind = 'pause' | 'broadcast' | 'recovery';

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
  recovery: OpenEntry<RecoveryRecord> | null;
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
  saveRecovery(record: RecoveryRecord): Promise<void>;
  /** Writes (or replaces) the file of the snapshot's runtime, then keeps only the newest 5 files; the file just written is never removed. */
  saveRoster(snapshot: RosterSnapshot): Promise<void>;
  /** Every kept roster snapshot, newest first. Fails naming the file when one cannot be read. */
  loadRosters(): Promise<RosterSnapshot[]>;
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
  /** The random part of a temporary file name; a fresh UUID when omitted. */
  tmpSuffix?: () => string;
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

// The parts of a temporary file name, `<path>.<pid>.<random>.tmp`: two writes never share one, in a process or across processes with the same pid.
interface TmpNames {
  pid: number;
  suffix: () => string;
}

async function writeAtomic(path: string, content: string, { pid, suffix }: TmpNames): Promise<void> {
  const tmp = `${path}.${pid}.${suffix()}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function writeRecord(folder: string, id: string, record: Run | BroadcastRecord | RecoveryRecord | RosterSnapshot, names: TmpNames): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeAtomic(join(folder, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, names);
}

// The IDs come from outside the tool: a character that is not safe in a file name becomes `_`. The real values stay in the file.
const safeName = (part: string): string => part.replace(/[^A-Za-z0-9._-]/g, '_');

/** The roster file of a runtime, without the extension: `<boot ID>-<runtime ID>` (`none` for a null runtime ID). */
export const rosterFileId = (bootId: string, runtimeId: string | null): string => `${safeName(bootId)}-${safeName(runtimeId ?? 'none')}`;

const ROSTER_KEEP = 5;

function isRosterSnapshot(value: unknown): value is RosterSnapshot {
  const v = value as Record<string, unknown> | null;
  return typeof v === 'object' && v !== null && typeof v.bootId === 'string' && (typeof v.runtimeId === 'string' || v.runtimeId === null) && typeof v.firstSavedAt === 'string' && typeof v.lastSavedAt === 'string' && Array.isArray(v.entries);
}

// Every roster file, newest first by last save time (equal times: the greater file name first). A missing folder counts as empty.
async function listRosters(folder: string): Promise<{ id: string; snapshot: RosterSnapshot }[]> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files = await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => {
        const path = join(folder, n);
        try {
          const value: unknown = JSON.parse(await readFile(path, 'utf8'));
          if (!isRosterSnapshot(value)) throw new Error('not a roster snapshot');
          return { id: n.slice(0, -'.json'.length), snapshot: value };
        } catch (error) {
          throw new Error(`cannot read roster file ${path}: ${(error as Error).message}`);
        }
      }),
  );
  // A plain comparison, not `localeCompare`: the order must not depend on the locale of the process.
  const newerFirst = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
  return files.sort((a, b) => newerFirst(a.snapshot.lastSavedAt, b.snapshot.lastSavedAt) || newerFirst(a.id, b.id));
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
  const recoveriesDir = join(dir, RECOVERIES);
  const rosterDir = join(dir, ROSTER);
  const tmpNames: TmpNames = { pid, suffix: options.tmpSuffix ?? randomUUID };
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
    await writeAtomic(pointerPath, `${JSON.stringify({ kind, id })}\n`, tmpNames);
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
      return (value.kind === 'pause' || value.kind === 'broadcast' || value.kind === 'recovery') && typeof value.id === 'string' ? { kind: value.kind, id: value.id } : null;
    } catch {
      return null;
    }
  }

  async function clearCurrent(kind: RecordKind, id: string): Promise<void> {
    const pointer = await readPointer();
    if (pointer?.kind === kind && pointer.id === id) await removeIfPresent(pointerPath);
  }

  async function peekOpen(): Promise<OpenRecords> {
    const [pause, broadcast, recovery] = await Promise.all([
      readOpen<Run>(pausesDir, (r) => r.startedAt, (r) => r.runId, backfillRunIds),
      readOpen<BroadcastRecord>(broadcastsDir, (r) => r.createdAt, (r) => r.id, backfillTargets),
      readOpen<RecoveryRecord>(recoveriesDir, (r) => r.createdAt, (r) => r.id),
    ]);
    return { pause, broadcast, recovery };
  }

  async function loadOpen(): Promise<LoadedRecords> {
    const open = await peekOpen();
    const notes: string[] = [];
    // When several records of one kind are open the newest wins and the others are only reported.
    if (open.pause?.others.length) notes.push(`other pause runs are open and were left as they are: ${open.pause.others.map((r) => r.runId).join(', ')}`);
    if (!open.pause && open.broadcast?.others.length) notes.push(`other broadcasts are open and were left as they are: ${open.broadcast.others.map((r) => r.id).join(', ')}`);
    if (!open.pause && open.recovery?.others.length) notes.push(`other recoveries are open and were left as they are: ${open.recovery.others.map((r) => r.id).join(', ')}`);
    // An open pause run wins the pointer, and every broadcast open beside it is abandoned: one record is open at a time.
    if (open.pause && open.broadcast) {
      for (const record of [open.broadcast.record, ...open.broadcast.others]) {
        abandonPending(record, 'paused');
        await writeRecord(broadcastsDir, record.id, record, tmpNames);
        notes.push(`broadcast ${record.id} was open beside a pause run and is now abandoned`);
      }
      open.broadcast = null;
    }
    // The same for every recovery open beside a pause run.
    if (open.pause && open.recovery) {
      for (const record of [open.recovery.record, ...open.recovery.others]) {
        abandonRecovery(record, 'paused');
        await writeRecord(recoveriesDir, record.id, record, tmpNames);
        notes.push(`recovery ${record.id} was open beside a pause run; abandoned`);
      }
      open.recovery = null;
    }
    // A recovery and a broadcast open together, with no pause run: both stay open, and the user is told how to clear them.
    if (!open.pause && open.recovery && open.broadcast) {
      notes.push(`recovery ${open.recovery.record.id} and broadcast ${open.broadcast.record.id} are both open; run orca-broadcast close to abandon both`);
    }
    // A pause run wins. Between a recovery and a broadcast the newer wins; a tie goes to the recovery.
    const recoveryWins = open.recovery && (!open.broadcast || open.recovery.record.createdAt >= open.broadcast.record.createdAt);
    let winner: Pointer | null = null;
    if (open.pause) winner = { kind: 'pause', id: open.pause.record.runId };
    else if (recoveryWins && open.recovery) winner = { kind: 'recovery', id: open.recovery.record.id };
    else if (open.broadcast) winner = { kind: 'broadcast', id: open.broadcast.record.id };
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

    save: (run) => writeRecord(pausesDir, run.runId, run, tmpNames),

    saveBroadcast: (record) => writeRecord(broadcastsDir, record.id, record, tmpNames),

    saveRecovery: (record) => writeRecord(recoveriesDir, record.id, record, tmpNames),

    async saveRoster(snapshot) {
      const id = rosterFileId(snapshot.bootId, snapshot.runtimeId);
      await writeRecord(rosterDir, id, snapshot, tmpNames);
      const all = await listRosters(rosterDir);
      const kept = all.slice(0, ROSTER_KEEP);
      const written = all.find((file) => file.id === id);
      // The file just written is never removed, even when a clock that ran backwards makes it the oldest.
      if (written && !kept.includes(written)) kept[ROSTER_KEEP - 1] = written;
      for (const file of all) if (!kept.includes(file)) await removeIfPresent(join(rosterDir, `${file.id}.json`));
    },

    async loadRosters() {
      return (await listRosters(rosterDir)).map((file) => file.snapshot);
    },

    async removeRun(runId) {
      await removeIfPresent(join(pausesDir, `${runId}.json`));
      await clearCurrent('pause', runId);
    },
  };
}
