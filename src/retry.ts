import { sleepOrAbort, throwIfAborted } from './abort.js';
import type { Clock } from './types.js';

const ATTEMPTS = 3;
const DELAY_MS = 1000;

export async function withRetry<T>(call: () => Promise<T>, clock: Clock, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await call();
    } catch (error) {
      if (attempt === ATTEMPTS) throw error;
    }
    await sleepOrAbort(clock, DELAY_MS, signal);
  }
}
