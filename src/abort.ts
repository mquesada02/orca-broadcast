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
