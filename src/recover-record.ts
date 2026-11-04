import { clearPid } from './shared.js';
import type { RecoverRow, RecoveryRecord, RecoveryRow } from './types.js';

/**
 * A row is final when no further start, send or wait is planned for it: `acked`, `gone`, `left-to-coordinator`, `no-coordinator`, `failed`
 * and `abandoned` always; `restored` and `restarted` only when no prompt follows. `pending` never is.
 */
function isFinalRow(row: Pick<RecoveryRow, 'status' | 'reason' | 'promptDue' | 'coordinatorSessionId'>, rows: Pick<RecoveryRow, 'sessionId' | 'status'>[]): boolean {
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

/** The process no longer runs this recovery: drop its pid, and close the record by itself when every row is final. */
export function releaseRecovery(record: RecoveryRecord): void {
  clearPid(record);
  if (record.rows.every((row) => isFinalRow(row, record.rows))) {
    record.status = 'closed';
    record.endedBy = 'done';
  }
}

/** The row as the table and the `--json` line show it. */
export function recoveryRowOf(row: RecoveryRow): RecoverRow {
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
