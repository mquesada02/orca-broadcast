import { clearPid } from './shared.js';
import type { BroadcastRecord, RecoverReason, RecoverRow, RecoveryRecord, RecoveryRow, RosterEntry, RunRecoveryRow } from './types.js';

/**
 * A row is final when no further start, send or wait is planned for it: `acked`, `gone`, `left-to-coordinator`, `no-coordinator`, `failed`
 * and `abandoned` always; `restored` and `restarted` only when no prompt follows. `pending` never is.
 */
export function isFinalRow(row: Pick<RecoveryRow, 'status' | 'reason' | 'promptDue' | 'coordinatorSessionId'>, rows: Pick<RecoveryRow, 'sessionId' | 'status'>[]): boolean {
  switch (row.status) {
    case 'no-coordinator':
      // The exception: a worker whose coordinator did not get the list yet is decided again with its coordinator, while that row is pending.
      return !(row.reason === 'coordinator-missing' && row.coordinatorSessionId !== undefined && rows.some((other) => other.sessionId === row.coordinatorSessionId && other.status === 'pending'));
    case 'acked':
    case 'gone':
    case 'left-to-coordinator':
    case 'failed':
    case 'abandoned':
      return true;
    case 'restored':
    case 'restarted':
      return !row.promptDue;
    case 'pending':
      return false;
  }
}

// Drops the pid, and closes the record when every row is final.
function closeIfFinal(record: RecoveryRecord, endedBy: NonNullable<RecoveryRecord['endedBy']>): void {
  clearPid(record);
  if (record.rows.every((row) => isFinalRow(row, record.rows))) {
    record.status = 'closed';
    record.endedBy = endedBy;
  }
}

/** The process no longer runs this recovery: drop its pid, and close the record by itself when every row is final. */
export const releaseRecovery = (record: RecoveryRecord): void => closeIfFinal(record, 'done');

/**
 * Abandons the rows of a recovery that nobody runs any more: every row that is not final (and that `select` picks) becomes `abandoned`
 * with the reason, and every final row keeps its result. The record drops its pid, and closes (`endedBy: abandoned`) when every row is
 * final afterwards. Returns the number of rows it abandoned.
 */
export function abandonRecovery(record: RecoveryRecord, reason: Extract<RecoverReason, 'closed' | 'paused'>, select: (row: RecoveryRow) => boolean = () => true): number {
  // Chosen before any row changes: a worker that waits for a pending coordinator is not final yet.
  const chosen = record.rows.filter((row) => !isFinalRow(row, record.rows) && select(row));
  for (const row of chosen) {
    row.status = 'abandoned';
    row.reason = reason;
  }
  closeIfFinal(record, 'abandoned');
  return chosen.length;
}

/** The roster entry of a row: the row without its result and its recovery fields. */
export function entryOf(row: RecoveryRow): RosterEntry {
  const { status, reason, promptDue, messagePending, baseline, listDue, startedAt, extraWorkers, ...entry } = row;
  return entry;
}

/** A recovery record has `rows`; a broadcast record has `targets`. */
export const isRecoveryRecord = (record: BroadcastRecord | RecoveryRecord | null | undefined): record is RecoveryRecord => record !== null && record !== undefined && 'rows' in record;

/** The row as the table and the `--json` line show it. */
export function recoveryRowOf(row: RunRecoveryRow): RecoverRow {
  return {
    sessionId: row.sessionId,
    repo: row.repo,
    worktree: row.worktree,
    worktreePath: row.worktreePath,
    role: row.role,
    status: row.status,
    reason: row.reason,
    dispatchId: row.role === 'worker' ? (row.dispatchId ?? null) : null,
  };
}
