import { Interrupted, sleepOrAbort, throwIfAborted } from './abort.js';
import { failure, POLL_INTERVAL_MS } from './shared.js';
import { LockHeldError, type LockOwner, type RecordStore } from './store.js';
import type { BroadcastRecord, Clock, RunSummary } from './types.js';

export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
}

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** How long a command waits for the lock after it stopped a broadcast. */
export const HANDOVER_TIMEOUT_MS = 5000;

// How a command takes the lock over from a broadcast that is still waiting for acks.
export interface HandOver {
  clock: Clock;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Runs once the owner is proven to be the open broadcast, before any signal. A summary ends the command and nothing is signalled. */
  precheck: (signal: AbortSignal) => Promise<RunSummary | null>;
}

// The one process the open broadcast names is alive now, with the same start time, and holds the lock. A missing start time never proves it.
function isTheBroadcast(store: RecordStore, owner: LockOwner, broadcast: BroadcastRecord): boolean {
  return (
    owner.startTime !== undefined &&
    broadcast.pid === owner.pid &&
    broadcast.startTime === owner.startTime &&
    store.isProcessAlive(owner.pid) &&
    store.processStartTime(owner.pid) === owner.startTime
  );
}

const sameOwner = (a: LockOwner, b: LockOwner) => a.pid === b.pid && a.startTime === b.startTime;

// The lock is held. Stops the broadcast that holds it and returns the lock, or throws `held` when the holder is anything else.
async function handOverFromBroadcast(store: RecordStore, handOver: HandOver, signal: AbortSignal, held: Error): Promise<{ release: () => Promise<void> } | { summary: RunSummary }> {
  // The error alone says nothing about who holds the lock: decide from the lock file and the records.
  // A pause run open beside the broadcast is inconsistent state that the repairing load fixes: there is no hand-over then.
  const [owner, open] = await Promise.all([store.lockOwner(), store.peekOpen()]);
  const broadcast = open.broadcast?.record;
  if (!owner || !broadcast || open.pause || !isTheBroadcast(store, owner, broadcast)) throw held;

  const early = await handOver.precheck(signal);
  if (early) return { summary: early };
  throwIfAborted(signal);
  // Closes the window between the proof and the signal as far as a check can.
  if (store.processStartTime(owner.pid) !== owner.startTime) throw new Error(`the lock owner (pid ${owner.pid}) changed; no signal was sent`);
  try {
    handOver.kill(owner.pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') throw new Error(`not allowed to stop the broadcast (pid ${owner.pid})`);
    if (code !== 'ESRCH') throw error; // ESRCH: the process is already gone; the lock follows
  }

  const startedAt = handOver.clock.now();
  while (true) {
    try {
      return { release: await store.acquireLock() };
    } catch (error) {
      if (!(error instanceof LockHeldError)) throw error;
    }
    const now = await store.lockOwner();
    if (now && !sameOwner(now, owner)) throw held;
    const remaining = HANDOVER_TIMEOUT_MS - (handOver.clock.now() - startedAt);
    if (remaining <= 0) throw new Error(`the broadcast (pid ${owner.pid}) did not stop within ${HANDOVER_TIMEOUT_MS / 1000} s`);
    await sleepOrAbort(handOver.clock, Math.min(POLL_INTERVAL_MS, remaining), signal);
  }
}

export interface GuardOptions {
  /** Runs once, before the lock, with read-only calls only. Throws to refuse the command, so nothing has been stopped or written yet. */
  prelock?: (signal: AbortSignal) => Promise<void>;
  handOver?: HandOver;
}

// The lock, or the summary that ends the command before it starts. An interrupt in this phase is exit 130 with nothing written.
async function acquire(store: RecordStore, signal: AbortSignal, { prelock, handOver }: GuardOptions): Promise<{ release: () => Promise<void> } | { summary: RunSummary }> {
  try {
    throwIfAborted(signal);
    await prelock?.(signal);
    throwIfAborted(signal);
    try {
      return { release: await store.acquireLock() };
    } catch (error) {
      if (!handOver || !(error instanceof LockHeldError)) throw error;
      return await handOverFromBroadcast(store, handOver, signal, error);
    }
  } catch (error) {
    if (error instanceof Interrupted) return { summary: failure(error, null) };
    throw error;
  }
}

// Stop signals are listened for before anything else happens and removed before the lock is released.
export async function withLockAndSignals(store: RecordStore, signals: SignalSource, run: (signal: AbortSignal) => Promise<RunSummary>, options: GuardOptions = {}): Promise<RunSummary> {
  const abort = new AbortController();
  const handlers = STOP_SIGNALS.map((name) => [name, () => abort.abort(name)] as const);
  for (const [name, handler] of handlers) signals.on(name, handler);
  let release: (() => Promise<void>) | undefined;
  try {
    const taken = await acquire(store, abort.signal, options);
    if ('summary' in taken) return taken.summary;
    release = taken.release;
    return await run(abort.signal);
  } finally {
    for (const [name, handler] of handlers) signals.off(name, handler);
    await release?.();
  }
}
