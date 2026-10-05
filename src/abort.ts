import type { Clock } from './types.js';

export class Interrupted extends Error {
  constructor(signal: AbortSignal) {
    super(`interrupted by ${String(signal.reason)}`);
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Interrupted(signal);
}

export async function sleepOrAbort(clock: Clock, ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  try {
    await clock.sleep(ms, signal);
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  throwIfAborted(signal);
}

// Settles like the promise, or rejects with Interrupted as soon as the signal aborts.
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Interrupted(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
