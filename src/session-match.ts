import { holdersBySession, livePanes, sessionsByPane } from './roster.js';
import type { Snapshot } from './shared.js';
import type { AgentRecord, SessionScan } from './types.js';

/** The records of a pause run that moved to a new pane, by their old `paneKey`: the pane key and terminal handle where the same Claude session lives now. */
export type SessionMatches = Map<string, { paneKey: string; handle: string }>;

/**
 * Finds where the recorded agents of a run live now, by Claude session ID, from the scan of the start save (no scan of its own).
 * Only a record that has a session ID and is not `gone` can move. A record that no live agent holds, or a failed scan, leaves the
 * record to the `paneKey` lookup. Records are taken in run order; two records never end on one pane.
 * A failed scan adds a warning when there is something to match, unless the command was aborted.
 */
export function matchSessions(records: AgentRecord[], snapshot: Snapshot, scan: SessionScan | null, warnings: string[], signal?: AbortSignal): SessionMatches {
  const matches: SessionMatches = new Map();
  const candidates = records.flatMap((record) => (record.sessionId !== undefined && record.resumeStatus !== 'gone' ? [{ record, sessionId: record.sessionId }] : []));
  if (scan === null) {
    if (candidates.length > 0 && !signal?.aborted) warnings.push('session IDs were not matched, because the process scan failed: agents were matched by pane key');
    return matches;
  }

  // The live agent of each session ID: the rule of the roster, so a record never matches another pane than the roster saved.
  const holder = holdersBySession(livePanes(snapshot, sessionsByPane(scan)));

  // A pane that any record of the run holds now (a `gone` record included), or that an earlier match took, is never a target: that is
  // what keeps two records off one pane. So two records that would swap panes both stay and fall back to `paneKey`.
  const taken = new Set(records.map((record) => record.paneKey));
  for (const { record, sessionId } of candidates) {
    const live = holder.get(sessionId);
    if (live === undefined) continue;
    const target = live.row.paneKey;
    if (target === record.paneKey || taken.has(target)) continue;
    matches.set(record.paneKey, { paneKey: target, handle: live.handle });
    taken.add(target);
  }
  return matches;
}

/** Moves the matched records to their new pane, in memory: `paneKey` and last handle. Nothing else of a record changes here. */
export function applySessionMatches(records: AgentRecord[], matches: SessionMatches): void {
  for (const record of records) {
    const to = record.resumeStatus === 'gone' ? undefined : matches.get(record.paneKey);
    if (!to) continue;
    record.paneKey = to.paneKey;
    record.lastHandle = to.handle;
  }
}
