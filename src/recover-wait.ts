import { sleepOrAbort, throwIfAborted } from './abort.js';
import { START_WINDOW_MS } from './recover-classify.js';
import { startAgents, type Started, type StartDeps } from './recover-start.js';
import { continueText, workerItems } from './recover-prompt.js';
import { holdersBySession, livePanes, sessionsByPane } from './roster.js';
import { ackLine, busyReason, coordinatorsFirst, hasNewReply, isSendable, isWaitingLike, listFresh, locate, markTranscript, POLL_INTERVAL_MS, proves, sendDue, transcriptProof, type TranscriptReadState } from './shared.js';
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
  /** The rows this run works on: every row of the record, or on a re-run the rows in its scope. Other rows are never started, prompted or waited on. */
  rows: RecoveryRow[];
  /** The rows that wait for a start that an earlier run recorded and that has not appeared: this run did not start them and does not fail them at its timeout. */
  earlier: RecoveryRow[];
}

const setResult = (row: RecoveryRow, status: RecoveryRow['status'], reason: RecoveryRow['reason']): void => {
  row.status = status;
  row.reason = reason;
};

const isAwaitingStart = (row: RecoveryRow): boolean => row.status === 'pending' && row.reason === 'awaiting-start';

// A row the loop still has to bring to a result: a start that has not appeared, or a prompt that is not acked and can still progress.
export const needsWait = (row: RecoveryRow): boolean => isAwaitingStart(row) || (row.promptDue && row.status === 'pending' && row.reason !== 'send-failed');

interface LiveRow {
  row: RecoveryRow;
  paneKey: string;
  live: AgentRow;
}

/**
 * The loop that follows the starts. Each tick takes a listing; joins the started rows that appeared (one scan, only when a live row is
 * in no record of the latest scan); decides the result of every live row due a prompt (ack, gone, or the reason it is still pending);
 * and sends the prompt to each row that is due, coordinators first. It always makes one tick, and ends when no row needs more waiting
 * or the deadline has passed after a tick. A row that this run started and that has still not appeared then fails. A row that waits
 * for a start of an earlier run stays pending; when that start reaches the window, it is dropped and the row is started like any other.
 */
export async function settle(started: Started, deps: SettleDeps): Promise<void> {
  const { port, clock, signal, deadline, token, panes, rows } = deps;
  let scan = started.scan ?? deps.scan;
  let awaiting = [...started.awaiting, ...deps.earlier];
  const earlier = new Set(deps.earlier);
  let lastScanFailed = false;
  let unjoined = false;
  const transcripts: TranscriptReadState = { positions: new Map(), missing: new Set() };
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

    // A start of an earlier run that reached the window without its agent: dropped, and the row is started like any missing agent.
    for (const row of awaiting.filter((r) => earlier.has(r) && clock.now() - Date.parse(r.startedAt as string) >= START_WINDOW_MS)) {
      earlier.delete(row);
      awaiting = awaiting.filter((r) => r !== row);
      delete row.startedAt;
      setResult(row, 'pending', 'timed-out');
      const again = await startAgents([row], deps);
      started.count += again.count;
      if (again.scan) scan = again.scan;
      for (const [sessionId, pane] of again.panes) panes.set(sessionId, pane);
      awaiting.push(...again.awaiting);
    }
    for (const sessionId of panes.keys()) {
      const holder = holders.get(sessionId);
      if (holder) panes.set(sessionId, holder.row.paneKey);
    }

    const due: LiveRow[] = [];
    for (const row of rows.filter((r) => r.promptDue && r.status === 'pending' && panes.has(r.sessionId))) {
      // The map was just refreshed from the live holders, so it names the live pane, else the pane where the session was last seen.
      const paneKey = panes.get(row.sessionId) as string;
      const found = locate(paneKey, agents, terminals);
      if ('gone' in found) {
        setResult(row, 'gone', found.gone);
        continue;
      }
      // Either check proves the row: Orca's last reply, or any reply that ended a turn since the send (a later turn may hide the ack line).
      if (proves(row, found.row, token) || (row.transcript !== undefined && (await transcriptProof(port, row.sessionId, row.transcript, ackLine(token), transcripts)))) {
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
      // The first send that has an identity takes the offset; a re-send keeps it.
      const identity = row.transcript ? undefined : holders.get(row.sessionId)?.record.transcript;
      const taken = identity ? await markTranscript(port, identity) : null;
      if (taken) row.transcript = taken;
      const listed = rows.filter((worker) => worker.listDue && worker.coordinatorSessionId === row.sessionId);
      const result = await port.send(found.handle, continueText(token, workerItems(listed, row.extraWorkers ?? []))).catch(() => ({ accepted: false as const }));
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
    if (!rows.some(needsWait) || clock.now() >= deadline) break;
    await sleepOrAbort(clock, Math.min(POLL_INTERVAL_MS, deadline - clock.now()), signal);
  }
  for (const row of awaiting) if (!earlier.has(row)) setResult(row, 'failed', lastScanFailed && unjoined ? 'scan-failed' : 'did-not-appear');
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
