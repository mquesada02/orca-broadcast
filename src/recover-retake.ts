import { entryOf } from './recover-record.js';
import { sameRuntime } from './recover-set.js';
import type { RecoveryRecord, RecoveryRow, RosterEntry, RuntimeKey } from './types.js';

const sameKey = (a: RuntimeKey, b: RuntimeKey): boolean => a.bootId === b.bootId && a.runtimeId === b.runtimeId;

// The results that a later `recover` takes again; every other result stays only in the earlier record.
const RETAKEN = new Set<RecoveryRow['status']>(['failed', 'gone', 'no-coordinator']);

/**
 * Whether a closed recovery record is the earlier recovery of this restart: it used the same newest snapshot (the same key, whatever
 * saves changed that snapshot since) and ran in the same live runtime as now.
 */
export const isSameRestart = (closed: RecoveryRecord, snapshotKey: RuntimeKey, live: RuntimeKey): boolean => sameKey(closed.snapshotKey, snapshotKey) && sameRuntime(closed.liveRuntime, live);

export interface RetakeSet {
  /** The retaken rows, then the coordinators that they may bring in, as roster entries. */
  entries: RosterEntry[];
  /** The recorded start of each retaken row that has one, by session ID. */
  starts: Map<string, string>;
  /** The session IDs of the coordinators that are candidates only: rows of the earlier record that are not retaken. */
  bringIn: Set<string>;
}

export function retakeSet(closed: RecoveryRecord): RetakeSet {
  const retaken = closed.rows.filter((row) => RETAKEN.has(row.status));
  const taken = new Set(retaken.map((row) => row.sessionId));
  const wanted = new Set(retaken.filter((row) => row.role === 'worker' && row.coordinatorSessionId !== undefined).map((row) => row.coordinatorSessionId as string));
  const candidates = closed.rows.filter((row) => wanted.has(row.sessionId) && !taken.has(row.sessionId));
  const starts = new Map<string, string>();
  for (const row of retaken) if (row.startedAt !== undefined) starts.set(row.sessionId, row.startedAt);
  return { entries: [...retaken, ...candidates].map(entryOf), starts, bringIn: new Set(candidates.map((row) => row.sessionId)) };
}

/** The workers that the earlier record left to this coordinator: they are listed in its prompt when their sessions are still free. */
export const leftWorkers = (closed: RecoveryRecord, coordinatorSessionId: string): RosterEntry[] =>
  closed.rows.filter((row) => row.status === 'left-to-coordinator' && row.coordinatorSessionId === coordinatorSessionId).map(entryOf);
