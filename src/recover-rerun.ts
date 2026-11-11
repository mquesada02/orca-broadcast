import { applyStarts, buildRows, classify, compare, finalRows, recheckHeld, type Classified, type Item, type RecheckDeps } from './recover-classify.js';
import { entryOf, isFinalRow, recoveryRowOf } from './recover-record.js';
import { holdersBySession, livePanes, paneOfSession, sessionsByPane } from './roster.js';
import { locate, type Snapshot } from './shared.js';
import type { RecoverRow, RecoveryRow, SessionScan } from './types.js';

export interface RerunContext extends RecheckDeps {
  snapshot: Snapshot;
  scan: SessionScan;
  /** The session ID of the session that runs `recover`, when it is known. */
  selfSessionId: string | null;
  /** Every stored row of the record, and the rows that the filters and the self rule leave in scope. */
  rows: RecoveryRow[];
  scope: RecoveryRow[];
  /** `--keep-tabs`: the plan lists no worktree to clear. */
  keepTabs: boolean;
}

export interface RerunPlan {
  classified: Classified;
  /** The rows that a start is due for. */
  restarts: RecoveryRow[];
  /** The rows that wait for a start that an earlier run recorded. */
  earlier: RecoveryRow[];
  /** Session ID to the pane of each agent that is live now. */
  panes: Map<string, string>;
  /** The newest scan. */
  scan: SessionScan;
  /** The table of a declined confirmation. */
  declined: RecoverRow[];
}

// A row whose prompt was sent: it is only waited on again.
const isSent = (row: RecoveryRow): boolean => row.status === 'pending' && row.reason !== 'awaiting-start' && row.promptDue && !row.messagePending;

// The fields that a classification decides; the rest of the stored row (identity, token fields, `extraWorkers`) stays.
function copyClassification(row: RecoveryRow, built: RecoveryRow): void {
  row.status = built.status;
  row.reason = built.reason;
  row.promptDue = built.promptDue;
  row.messagePending = built.messagePending;
  row.baseline = built.baseline;
  for (const key of ['listDue', 'startedAt'] as const) {
    if (built[key] === undefined) delete row[key];
    else Object.assign(row, { [key]: built[key] });
  }
}

/**
 * What a re-run does with the stored rows in scope. A final row keeps its result. A row whose prompt was sent is only waited on (it is
 * `gone` when no live row holds its session any more). Every other row is classified again from scratch, as in a first run, with the
 * recorded-start rules for a row that has a start. The stored rows are changed in memory; the caller saves them after the user's yes.
 */
export async function planRerun(ctx: RerunContext, build: (classified: Classified) => RecoveryRow[]): Promise<RerunPlan> {
  const { snapshot, scan, rows, scope } = ctx;
  const inScope = new Set(scope.map((row) => row.sessionId));
  const live = holdersBySession(livePanes(snapshot, sessionsByPane(scan)));
  const panes = new Map<string, string>();

  const open = scope.filter((row) => !isFinalRow(row, rows));
  // Decided before any row changes: a row that turns `gone` below is no longer a sent row, and must not go through the pass.
  const sentRows = open.filter(isSent);
  for (const row of sentRows) {
    const holder = live.get(row.sessionId);
    if (holder) {
      panes.set(row.sessionId, holder.row.paneKey);
      continue;
    }
    const found = locate(row.paneKey, snapshot.agents, snapshot.terminals);
    row.status = 'gone';
    row.reason = 'gone' in found ? found.gone : 'agent-missing';
  }

  const waiting = new Set(sentRows);
  const pass = open.filter((row) => !waiting.has(row));
  const byId = new Map(pass.map((row) => [row.sessionId, row]));
  const items: Item[] = classify(pass.map(entryOf), snapshot, scan);
  for (const item of items) {
    const start = byId.get(item.entry.sessionId)?.startedAt;
    if (start !== undefined) item.startedAt = start;
  }
  const { scanFailed, scan: rechecked } = await recheckHeld(items, ctx);
  applyStarts(items, ctx.clock.now());
  const newest = rechecked ?? scan;
  for (const { entry, standing } of items) {
    const pane = standing === 'restored' ? paneOfSession(newest, entry.sessionId) : undefined;
    if (pane !== undefined) panes.set(entry.sessionId, pane);
  }

  // A worker whose coordinator is in scope but final (or not in the pass) has no coordinator to get its list.
  const everyone = [...items.map((item) => item.entry), ...rows.filter((row) => !inScope.has(row.sessionId)).map(entryOf)];
  const classified = buildRows(items, { selfSessionId: ctx.selfSessionId, everyone, scanFailed, terminals: snapshot.terminals, keepTabs: ctx.keepTabs });

  const built = build(classified);
  const restarts: RecoveryRow[] = [];
  const earlier: RecoveryRow[] = [];
  classified.rows.forEach((row, i) => {
    const stored = byId.get(row.entry.sessionId) as RecoveryRow;
    copyClassification(stored, built[i] as RecoveryRow);
    if (row.restart) restarts.push(stored);
    if (row.awaiting) earlier.push(stored);
  });

  const shown = new Map(finalRows(classified, 'declined').map((row) => [row.sessionId, row]));
  const rank = (row: RecoveryRow): number => (row.role === 'coordinator' ? 0 : 1);
  const table = [...scope].sort((a, b) => rank(a) - rank(b) || compare(a.repo, b.repo) || compare(a.worktree, b.worktree) || compare(a.sessionId, b.sessionId) || compare(a.paneKey, b.paneKey));
  const declined = table.map((row) => shown.get(row.sessionId) ?? recoveryRowOf(row));
  return { classified, restarts, earlier, panes, scan: newest, declined };
}
