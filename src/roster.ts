import { isWaitingLike, iso, locate, roleInfoOf, type Snapshot } from './shared.js';
import type { AgentRow, RosterEntry, RosterSnapshot, SessionRecord, SessionScan } from './types.js';

// The scan record of each pane. When two records share a pane key the newest process wins; equal start times keep the first.
export function sessionsByPane(scan: SessionScan): Map<string, SessionRecord> {
  const byPane = new Map<string, SessionRecord>();
  for (const record of scan.sessions) {
    if (record.paneKey === null) continue;
    const current = byPane.get(record.paneKey);
    if (!current || record.startTime > current.startTime) byPane.set(record.paneKey, record);
  }
  return byPane;
}

/** A live Claude agent of a snapshot, with the scan record of its pane (undefined when the scan missed it). */
export interface LivePane {
  row: AgentRow;
  handle: string;
  record: SessionRecord | undefined;
}

export function livePanes(snapshot: Pick<Snapshot, 'agents' | 'terminals'>, sessions: Map<string, SessionRecord>): LivePane[] {
  const live: LivePane[] = [];
  for (const [paneKey, row] of snapshot.agents) {
    const found = locate(paneKey, snapshot.agents, snapshot.terminals);
    if (row.agentType === 'claude' && !('gone' in found)) live.push({ row, handle: found.handle, record: sessions.get(paneKey) });
  }
  return live;
}

/** The one live pane that holds each session ID: of two, the newest process wins, and a tie keeps the first row. */
export function holdersBySession(live: LivePane[]): Map<string, LivePane & { record: SessionRecord }> {
  const holder = new Map<string, LivePane & { record: SessionRecord }>();
  for (const pane of live) {
    if (!pane.record) continue;
    const current = holder.get(pane.record.sessionId);
    if (current === undefined || pane.record.startTime > current.record.startTime) holder.set(pane.record.sessionId, { ...pane, record: pane.record });
  }
  return holder;
}

// The session ID of the coordinator of a worker: its parent pane first, then the coordinator terminal of one of its runs.
function coordinatorSessionId(row: AgentRow, runIds: string[], snapshot: Snapshot, sessions: Map<string, SessionRecord>): string | undefined {
  const parent = row.parentPaneKey === null ? undefined : sessions.get(row.parentPaneKey);
  if (parent) return parent.sessionId;
  for (const runId of runIds) {
    const handle = snapshot.runs.find((run) => run.id === runId)?.coordinatorHandle;
    const terminal = handle ? [...snapshot.terminals.values()].find((t) => t.handle === handle) : undefined;
    const found = terminal ? sessions.get(terminal.paneKey) : undefined;
    if (found) return found.sessionId;
  }
  return undefined;
}

/**
 * Builds the roster snapshot of the live runtime from one listing snapshot and one scan.
 * `previous` is the earlier snapshot of the same file: its entries for live panes that the scan missed are carried over unchanged.
 */
export function buildRoster(snapshot: Snapshot, scan: SessionScan, previous: RosterSnapshot | null, bootId: string, now: number): RosterSnapshot {
  const savedAt = iso(now);
  const sessions = sessionsByPane(scan);

  const live = livePanes(snapshot, sessions);

  // Entries are unique by session ID: of two rows with one session ID the newest process keeps it; equal start times keep the first row.
  const winner = holdersBySession(live);

  const entries: RosterEntry[] = [];
  for (const { row, handle, record } of live) {
    if (!record || winner.get(record.sessionId)?.row.paneKey !== row.paneKey) continue;
    const { role, orchestrationRunIds } = roleInfoOf(snapshot.roles, row.paneKey);
    const entry: RosterEntry = {
      sessionId: record.sessionId,
      paneKey: row.paneKey,
      repo: row.repo,
      repoId: row.repoId,
      worktree: row.worktree,
      worktreeId: row.worktreeId,
      worktreePath: row.path,
      role,
      orchestrationRunIds,
      state: isWaitingLike(row.state) ? 'waiting' : (row.state as 'working' | 'done'),
      stateStartedAt: row.stateStartedAt,
      savedAt,
    };
    if (role === 'worker') {
      const coordinator = coordinatorSessionId(row, orchestrationRunIds, snapshot, sessions);
      if (coordinator !== undefined) entry.coordinatorSessionId = coordinator;
      const dispatchId = snapshot.workers.find((worker) => worker.handle === handle && worker.dispatchId !== undefined)?.dispatchId;
      if (dispatchId !== undefined) entry.dispatchId = dispatchId;
    }
    if (record.permission !== null) entry.permission = record.permission;
    entries.push(entry);
  }

  // A live pane whose session ID this scan missed keeps the entries it had in the previous snapshot.
  const missed = new Set(live.filter(({ record }) => !record).map(({ row }) => row.paneKey));
  const taken = new Set(entries.map((entry) => entry.sessionId));
  for (const entry of previous?.entries ?? []) {
    if (missed.has(entry.paneKey) && !taken.has(entry.sessionId)) entries.push(entry);
  }

  return { bootId, runtimeId: snapshot.runtimeId, firstSavedAt: previous?.firstSavedAt ?? savedAt, lastSavedAt: savedAt, entries };
}
