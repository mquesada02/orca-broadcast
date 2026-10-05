import type { RecordStore } from './store.js';

export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
}

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// Stop signals are listened for before the lock is taken and removed before it is released.
export async function withLockAndSignals<T>(store: RecordStore, signals: SignalSource, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const handlers = STOP_SIGNALS.map((name) => [name, () => abort.abort(name)] as const);
  for (const [name, handler] of handlers) signals.on(name, handler);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await store.acquireLock();
    return await run(abort.signal);
  } finally {
    for (const [name, handler] of handlers) signals.off(name, handler);
    await release?.();
  }
}
