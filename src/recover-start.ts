import { throwIfAborted } from './abort.js';
import { classify } from './recover-classify.js';
import { paneOfSession } from './roster.js';
import { iso, listFresh } from './shared.js';
import type { Clock, OrcaPort, RecoveryRow, SessionScan } from './types.js';

export interface StartDeps {
  port: OrcaPort;
  clock: Clock;
  signal?: AbortSignal;
  /** Writes the record, or the pause run, that holds the rows being started. */
  save: () => Promise<void>;
  /** The end of the `--timeout` clock, the confirmation wait included. */
  deadline: number;
  warnings: string[];
  /** The clear step of the run, shared by every call of `startAgents` in it. */
  clearing: Clearing;
}

export interface Clearing {
  /** `--keep-tabs`: no worktree is counted or cleared. */
  keepTabs: boolean;
  /** The worktree paths where a start was already about to be made in this run. */
  considered: Set<string>;
  /** The worktrees this run cleared, in clear order. */
  cleared: { repo: string; worktree: string }[];
}

export interface Started {
  /** The rows whose start returned `started: true` and that have not appeared yet. */
  awaiting: RecoveryRow[];
  /** How many `startAgent` calls returned `started: true`. */
  count: number;
  /** The newest scan that succeeded in this step; null when none did. */
  scan: SessionScan | null;
  /** For each row found already `restored` right before its start (so it was not started): the pane that holds its session. */
  panes: Map<string, string>;
}

const setResult = (row: RecoveryRow, status: RecoveryRow['status'], reason: RecoveryRow['reason']): void => {
  row.status = status;
  row.reason = reason;
};

// A row found restored: when a prompt follows it stays pending (the prompt loop decides its result), else it is final.
const restored = (row: RecoveryRow): void => (row.promptDue ? setResult(row, 'pending', 'timed-out') : setResult(row, 'restored', null));

/**
 * The starts: for each row due a restart, in the order given, one listing and one scan right before the decision. A failed scan stops
 * all further starts. Every start is recorded and saved before it is made.
 */
export async function startAgents(rows: RecoveryRow[], deps: StartDeps): Promise<Started> {
  const { port, clock, signal, deadline } = deps;
  const started: Started = { awaiting: [], count: 0, scan: null, panes: new Map() };
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
      restored(row);
      const pane = paneOfSession(scan, row.sessionId);
      if (pane !== undefined) started.panes.set(row.sessionId, pane);
    } else if (item?.standing === 'held') {
      setResult(row, 'failed', 'session-held');
    } else if (item?.standing === 'unverifiable') {
      setResult(row, 'failed', 'unverifiable');
    } else {
      row.startedAt = iso(clock.now());
      setResult(row, 'pending', 'awaiting-start');
      await deps.save();
      // Before the first start in a worktree: clear it when the fresh listing holds no terminal there (an orphaned one counts as live).
      // The worktree is marked before the clear, so a failed clear is not tried again in this run (the spec: once per run).
      if (!deps.clearing.keepTabs && !deps.clearing.considered.has(row.worktreePath)) {
        deps.clearing.considered.add(row.worktreePath);
        if (![...terminals.values()].some((terminal) => terminal.worktreePath === row.worktreePath)) {
          const cleared = await port.clearWorktree(row.worktreePath);
          if (cleared.cleared) deps.clearing.cleared.push({ repo: row.repo, worktree: row.worktree });
          else deps.warnings.push(cleared.message);
        }
      }
      // A saved title is kept: the tab gets it and Claude Code may not repaint it. With none, the tab gets the label and Claude Code may name it.
      const savedTitle = row.title || null;
      const result = await port.startAgent(row.worktreePath, row.sessionId, row.permission ?? null, savedTitle ?? `${row.repo}/${row.worktree} (recovered)`, savedTitle !== null);
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
