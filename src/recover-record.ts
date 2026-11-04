import { clearPid } from './shared.js';
import type { RecoverRow, RecoveryRecord, RecoveryRow } from './types.js';

/**
 * A row is final when no further start, send or wait is planned for it: `acked`, `gone`, `left-to-coordinator`, `no-coordinator`, `failed`
 * and `abandoned` always; `restored` and `restarted` only when no prompt follows. `pending` never is.
 */
function isFinalRow(row: Pick<RecoveryRow, 'status' | 'promptDue'>): boolean {
  switch (row.status) {
    case 'acked':
    case 'gone':
    case 'left-to-coordinator':
    case 'no-coordinator':
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
  if (record.rows.every(isFinalRow)) {
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
