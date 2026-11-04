import { sessionsByPane } from './roster.js';
import { locate, type Snapshot } from './shared.js';
import type { AgentRecord, SessionScan } from './types.js';

/** The records of a pause run that moved to a new pane, by their old `paneKey`: the live `paneKey` and handle of the same Claude session. */
export type SessionMatches = Map<string, { paneKey: string; handle: string }>;

/**
 * Finds where the recorded agents of a run live now, by Claude session ID, from the scan of the start save (no scan of its own).
 * Only a record that has a session ID and is not `gone` can move. A record that no live agent holds, or a failed scan, leaves the
 * record to the `paneKey` lookup. Records are taken in run order; two records never end on one pane.
 * A failed scan adds a warning when there is something to match, unless the command was aborted.
 */
export function matchSessions(records: AgentRecord[], snapshot: Snapshot, scan: SessionScan | null, warnings: string[], signal?: AbortSignal): SessionMatches {
  const matches: SessionMatches = new Map();
  const candidates = records.filter((record) => record.sessionId !== undefined && record.resumeStatus !== 'gone');
  if (scan === null) {
    if (candidates.length > 0 && !signal?.aborted) warnings.push('session IDs were not matched, because the process scan failed: agents were matched by pane key');
    return matches;
  }

  // The live agent of each session ID: of two, the newest process wins, and a tie keeps the first row.
  const sessions = sessionsByPane(scan);
  const holder = new Map<string, { paneKey: string; handle: string; startTime: number }>();
  for (const [paneKey, row] of snapshot.agents) {
    const found = locate(paneKey, snapshot.agents, snapshot.terminals);
    const record = sessions.get(paneKey);
    if (row.agentType !== 'claude' || 'gone' in found || !record) continue;
    const current = holder.get(record.sessionId);
    if (current === undefined || record.startTime > current.startTime) holder.set(record.sessionId, { paneKey, handle: found.handle, startTime: record.startTime });
  }

  const taken = new Set(records.map((record) => record.paneKey));
  for (const record of candidates) {
    const live = holder.get(record.sessionId as string);
    if (live === undefined || live.paneKey === record.paneKey || taken.has(live.paneKey)) continue;
    matches.set(record.paneKey, { paneKey: live.paneKey, handle: live.handle });
    taken.add(live.paneKey);
  }
  return matches;
}

/** Moves the matched records to their new pane, in memory: `paneKey` and last handle. Nothing else of a record changes here. */
export function applySessionMatches(records: AgentRecord[], matches: SessionMatches): void {
  const moves = records.map((record) => ({ record, to: record.resumeStatus === 'gone' ? undefined : matches.get(record.paneKey) }));
  for (const { record, to } of moves) {
    if (!to) continue;
    record.paneKey = to.paneKey;
    record.lastHandle = to.handle;
  }
}
