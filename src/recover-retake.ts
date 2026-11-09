import { entryOf } from './recover-record.js';
import { sameRuntime } from './recover-set.js';
import type { RecoveryRecord, RecoveryRow, RosterEntry, RunRecovery, RuntimeKey } from './types.js';

export const sameKey = (a: RuntimeKey, b: RuntimeKey): boolean => a.bootId === b.bootId && a.runtimeId === b.runtimeId;

// The results that a later `recover` takes again; every other result stays only in the earlier record.
const RETAKEN = new Set<RecoveryRow['status']>(['failed', 'gone', 'no-coordinator']);
// The same in pause-run mode, which sends no prompt (so no `gone` row) and whose `pending` rows are taken again.
const RETAKEN_IN_RUN = new Set<RecoveryRow['status']>(['failed', 'no-coordinator', 'pending']);

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

function takeRows(rows: RecoveryRow[], statuses: Set<RecoveryRow['status']>): RetakeSet {
  const retaken = rows.filter((row) => statuses.has(row.status));
  const taken = new Set(retaken.map((row) => row.sessionId));
  const wanted = new Set(retaken.filter((row) => row.role === 'worker' && row.coordinatorSessionId !== undefined).map((row) => row.coordinatorSessionId as string));
  const candidates = rows.filter((row) => wanted.has(row.sessionId) && !taken.has(row.sessionId));
  const starts = new Map<string, string>();
  for (const row of retaken) if (row.startedAt !== undefined) starts.set(row.sessionId, row.startedAt);
  return { entries: [...retaken, ...candidates].map(entryOf), starts, bringIn: new Set(candidates.map((row) => row.sessionId)) };
}

export const retakeSet = (closed: RecoveryRecord): RetakeSet => takeRows(closed.rows, RETAKEN);

/** The retake of an open pause run: the stored rows that have a session ID (a row without one is made again from the run each time). */
export const retakeRunSet = (stored: RunRecovery): RetakeSet =>
  takeRows(
    stored.rows.filter((row): row is RecoveryRow => row.sessionId !== null),
    RETAKEN_IN_RUN,
  );

/** The workers that the earlier record left to this coordinator: they are listed in its prompt when their sessions are still free. */
export const leftWorkers = (closed: RecoveryRecord, coordinatorSessionId: string): RosterEntry[] =>
  closed.rows.filter((row) => row.status === 'left-to-coordinator' && row.coordinatorSessionId === coordinatorSessionId).map(entryOf);
