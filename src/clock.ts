import { setTimeout as sleep } from 'node:timers/promises';
import type { Clock } from './types.js';

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep,
};
