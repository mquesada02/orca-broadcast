import { sleepOrAbort, throwIfAborted } from './abort.js';
import { classify, liveSessionIds } from './recover-classify.js';
import { livePanes, sessionsByPane } from './roster.js';
import { iso, listFresh, POLL_INTERVAL_MS } from './shared.js';
import type { Clock, OrcaPort, RecoveryRecord, RecoveryRow, SessionScan } from './types.js';

export interface StartDeps {
  port: OrcaPort;
  clock: Clock;
  signal?: AbortSignal;
  /** The record whose rows are started; `save` writes it. */
  record: RecoveryRecord;
  save: () => Promise<void>;
  /** The end of the `--timeout` clock, the confirmation wait included. */
  deadline: number;
  warnings: string[];
}

export interface Started {
  /** The rows whose start returned `started: true` and that have not appeared yet. */
  awaiting: RecoveryRow[];
  /** How many `startAgent` calls returned `started: true`. */
  count: number;
  /** The newest scan that succeeded in this step; null when none did. */
  scan: SessionScan | null;
}

const setResult = (row: RecoveryRow, status: RecoveryRow['status'], reason: RecoveryRow['reason']): void => {
  row.status = status;
  row.reason = reason;
};

// A row whose prompt follows is not final yet; the prompts themselves are not built, so it ends `pending`, reason `timed-out`.
const appeared = (row: RecoveryRow): void => (row.promptDue ? setResult(row, 'pending', 'timed-out') : setResult(row, 'restarted', null));

/**
 * The starts: for each row due a restart, in the order given, one listing and one scan right before the decision. A failed scan stops
 * all further starts. Every start is recorded and saved before it is made.
 */
export async function startAgents(rows: RecoveryRow[], deps: StartDeps): Promise<Started> {
  const { port, clock, signal, deadline } = deps;
  const started: Started = { awaiting: [], count: 0, scan: null };
  let scanBroken = false;
  for (const row of rows) {
    throwIfAborted(signal);
    if (scanBroken) {
      setResult(row, 'failed', 'scan-failed');
      continue;
    }
    if (clock.now() >= deadline) continue;
    const [agents, terminals] = await listFresh({ port, clock, signal });
    let scan: SessionScan;
    try {
      scan = await port.scanSessions();
    } catch {
      scanBroken = true;
      setResult(row, 'failed', 'scan-failed');
      await deps.save();
      continue;
    }
    started.scan = scan;
    const [item] = classify([row], { agents, terminals }, scan);
    if (item?.standing === 'restored') {
      if (row.promptDue) setResult(row, 'pending', 'timed-out');
      else setResult(row, 'restored', null);
    } else if (item?.standing === 'held') {
      setResult(row, 'failed', 'session-held');
    } else if (item?.standing === 'unverifiable') {
      setResult(row, 'failed', 'unverifiable');
    } else {
      row.startedAt = iso(clock.now());
      setResult(row, 'pending', 'awaiting-start');
      await deps.save();
      const result = await port.startAgent(row.worktreePath, row.sessionId, row.permission ?? null, `${row.repo}/${row.worktree} (recovered)`);
      if (result.started) {
        started.count += 1;
        started.awaiting.push(row);
      } else {
        setResult(row, 'failed', result.reason);
        // A refused start created no process, so nothing is left to wait for; a failed start may have created a terminal.
        if (result.reason === 'start-failed') {
          if (result.message) deps.warnings.push(result.message);
        } else {
          delete row.startedAt;
        }
      }
    }
    await deps.save();
  }
  return started;
}

/**
 * The appearance wait. Each tick takes a listing, and one scan only when a live Claude agent is in no record of the latest successful
 * scan. A started row is `restarted` once a live row has its session ID. It always makes one tick; it ends when no row awaits or the
 * deadline has passed after a tick. A row still awaiting then fails: `scan-failed` when a live row is unjoined and the last scan failed,
 * else `did-not-appear`.
 */
export async function waitForAppearance(started: Started, deps: StartDeps): Promise<void> {
  const { port, clock, signal, deadline } = deps;
  let scan = started.scan ?? { sessions: [], unknown: [], heldByOthers: [] };
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
    const live = liveSessionIds(listing, scan);
    for (const row of awaiting) if (live.has(row.sessionId)) appeared(row);
    awaiting = awaiting.filter((row) => row.status === 'pending' && row.reason === 'awaiting-start');
    await deps.save();
    if (awaiting.length === 0 || clock.now() >= deadline) break;
    await sleepOrAbort(clock, Math.min(POLL_INTERVAL_MS, deadline - clock.now()), signal);
  }
  for (const row of awaiting) setResult(row, 'failed', lastScanFailed && unjoined ? 'scan-failed' : 'did-not-appear');
}
