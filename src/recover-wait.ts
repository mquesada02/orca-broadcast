import { sleepOrAbort, throwIfAborted } from './abort.js';
import type { Started, StartDeps } from './recover-start.js';
import { continueText, workerItems } from './recover-prompt.js';
import { holdersBySession, livePanes, sessionsByPane } from './roster.js';
import { busyReason, coordinatorsFirst, hasNewReply, isSendable, isWaitingLike, listFresh, locate, POLL_INTERVAL_MS, proves, sendDue } from './shared.js';
import type { AgentRow, RecoveryRow, SessionScan } from './types.js';

export interface SettleDeps extends StartDeps {
  /** The token of the recovery record: the ack line of every prompt. */
  token: string;
  /** The newest scan the run made; the loop starts from it unless the starts made a newer one. */
  scan: SessionScan;
  /**
   * Session ID to the pane that last held it, for the rows that are already live: the restored rows and the rows found restored right
   * before their start. The loop adds each restarted row when it appears and refreshes every entry from each listing. A row with no
   * entry has not been seen live, and the loop does not touch it.
   */
  panes: Map<string, string>;
}

const setResult = (row: RecoveryRow, status: RecoveryRow['status'], reason: RecoveryRow['reason']): void => {
  row.status = status;
  row.reason = reason;
};

const isAwaitingStart = (row: RecoveryRow): boolean => row.status === 'pending' && row.reason === 'awaiting-start';

// A row the loop still has to bring to a result: a start that has not appeared, or a prompt that is not acked and can still progress.
const needsWait = (row: RecoveryRow): boolean => isAwaitingStart(row) || (row.promptDue && row.status === 'pending' && row.reason !== 'send-failed');

interface LiveRow {
  row: RecoveryRow;
  paneKey: string;
  live: AgentRow;
}

/**
 * The loop that follows the starts. Each tick takes a listing; joins the started rows that appeared (one scan, only when a live row is
 * in no record of the latest scan); decides the result of every live row due a prompt (ack, gone, or the reason it is still pending);
 * and sends the prompt to each row that is due, coordinators first. It always makes one tick, and ends when no row needs more waiting
 * or the deadline has passed after a tick. A started row that has still not appeared then fails.
 */
export async function settle(started: Started, deps: SettleDeps): Promise<void> {
  const { port, clock, signal, deadline, record, token, panes } = deps;
  let scan = started.scan ?? deps.scan;
  let awaiting = started.awaiting;
  let lastScanFailed = false;
  let unjoined = false;
  while (true) {
    throwIfAborted(signal);
    const [agents, terminals] = await listFresh({ port, clock, signal });
    const listing = { agents, terminals };
    unjoined = livePanes(listing, sessionsByPane(scan)).some((pane) => pane.record === undefined);
    if (unjoined) {
      try {
        scan = await port.scanSessions();
        lastScanFailed = false;
        unjoined = livePanes(listing, sessionsByPane(scan)).some((pane) => pane.record === undefined);
      } catch {
        lastScanFailed = true;
      }
    }
    const holders = holdersBySession(livePanes(listing, sessionsByPane(scan)));

    // A started row is live once a pane that locate accepts holds its session ID.
    for (const row of awaiting) {
      const holder = holders.get(row.sessionId);
      if (!holder) continue;
      panes.set(row.sessionId, holder.row.paneKey);
      setResult(row, row.promptDue ? 'pending' : 'restarted', null);
    }
    awaiting = awaiting.filter(isAwaitingStart);
    for (const sessionId of panes.keys()) {
      const holder = holders.get(sessionId);
      if (holder) panes.set(sessionId, holder.row.paneKey);
    }

    const due: LiveRow[] = [];
    for (const row of record.rows.filter((r) => r.promptDue && r.status === 'pending' && panes.has(r.sessionId))) {
      const paneKey = holders.get(row.sessionId)?.row.paneKey ?? (panes.get(row.sessionId) as string);
      const found = locate(paneKey, agents, terminals);
      if ('gone' in found) {
        setResult(row, 'gone', found.gone);
        continue;
      }
      if (proves(row, found.row, token)) {
        setResult(row, 'acked', null);
        continue;
      }
      // no-ack only says that the agent replied without the ack line: it is not sent the prompt again, and a later ack still counts.
      if (row.reason !== 'send-failed') {
        row.reason = isWaitingLike(found.row.state) ? 'waiting-permission' : !row.messagePending && hasNewReply(row.baseline, found.row) ? 'no-ack' : busyReason(found.row);
      }
      due.push({ row, paneKey, live: found.row });
    }

    for (const { row, paneKey } of coordinatorsFirst(due.filter(({ row, live }) => sendDue(row, live)), ({ row }) => row.role)) {
      throwIfAborted(signal);
      await deps.save();
      const [freshAgents, freshTerminals] = await listFresh({ port, clock, signal });
      const found = locate(paneKey, freshAgents, freshTerminals);
      if ('gone' in found) {
        setResult(row, 'gone', found.gone);
        continue;
      }
      if (!isSendable(found.row)) {
        row.reason = 'waiting-permission';
        continue;
      }
      const listed = record.rows.filter((worker) => worker.listDue && worker.coordinatorSessionId === row.sessionId);
      const result = await port.send(found.handle, continueText(token, workerItems(listed, []))).catch(() => ({ accepted: false as const }));
      if (result.accepted) {
        row.baseline = found.row.lastAssistantMessage;
        row.messagePending = false;
        row.reason = busyReason(found.row);
        // The list was sent: its workers are left to the coordinator, whatever its ack shows.
        for (const worker of listed) {
          setResult(worker, 'left-to-coordinator', null);
          delete worker.listDue;
        }
      } else {
        row.reason = 'send-failed';
      }
      await deps.save();
    }

    await deps.save();
    if (!record.rows.some(needsWait) || clock.now() >= deadline) break;
    await sleepOrAbort(clock, Math.min(POLL_INTERVAL_MS, deadline - clock.now()), signal);
  }
  for (const row of awaiting) setResult(row, 'failed', lastScanFailed && unjoined ? 'scan-failed' : 'did-not-appear');
}

/**
 * After the loop: a missing worker whose coordinator did not get the list (its start failed or did not appear, its prompt was held
 * back or failed, or it is gone) is `no-coordinator`, reason `coordinator-missing`. It is not final while its coordinator row is pending.
 */
export function resolveWorkers(rows: RecoveryRow[]): void {
  for (const row of rows) {
    if (!row.listDue) continue;
    setResult(row, 'no-coordinator', 'coordinator-missing');
    delete row.listDue;
  }
}
