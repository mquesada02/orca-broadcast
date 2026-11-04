import { iso } from './shared.js';
import type { RosterEntry, RosterSnapshot, RuntimeKey, SnapshotLine } from './types.js';

// Two keys are one runtime when the boot IDs are equal and the runtime IDs are equal or either is unknown (null).
export const sameRuntime = (a: RuntimeKey, b: RuntimeKey): boolean =>
  a.bootId === b.bootId && (a.runtimeId === null || b.runtimeId === null || a.runtimeId === b.runtimeId);

// A runtime that lived less than an hour: the restart that ended it is taken as part of one chain of quick restarts.
const SHORT_RUNTIME_MS = 60 * 60_000;

const isShort = (snapshot: RosterSnapshot): boolean => Date.parse(snapshot.lastSavedAt) - Date.parse(snapshot.firstSavedAt) < SHORT_RUNTIME_MS;

export const FALLBACK_NOTICE = "no snapshot from before the restart; using the live runtime's snapshot (best effort)";

export interface PreRestartSet {
  entries: RosterEntry[];
  /** One line per snapshot used, newest first. */
  snapshots: SnapshotLine[];
  /** The key of the newest snapshot used. */
  key: RuntimeKey;
  /** Set when no snapshot of another runtime exists and the live runtime's own snapshot is used. */
  notice: string | null;
}

/**
 * The agents that were alive before the restart. `rosters` are the kept snapshots, newest first, and not empty.
 * The newest snapshot of a runtime other than the live one starts the set. While the runtime of the last snapshot added was short,
 * the next older snapshot of another runtime than the live one is added (a chain of quick restarts); the chain stops at the oldest
 * kept snapshot. Snapshots merge by session ID and the newer entry wins.
 */
export function preRestartSet(rosters: RosterSnapshot[], live: RuntimeKey, now: number): PreRestartSet {
  const others = rosters.filter((roster) => !sameRuntime(roster, live));
  const fallback = others.length === 0;
  const [first, ...older] = (fallback ? rosters : others) as [RosterSnapshot, ...RosterSnapshot[]];
  const used = [first];
  if (!fallback) {
    for (const next of older) {
      if (!isShort(used.at(-1) as RosterSnapshot)) break;
      used.push(next);
    }
  }

  const entries = new Map<string, RosterEntry>();
  for (const roster of used) for (const entry of roster.entries) if (!entries.has(entry.sessionId)) entries.set(entry.sessionId, entry);

  return {
    entries: [...entries.values()],
    key: { bootId: first.bootId, runtimeId: first.runtimeId },
    snapshots: used.map((roster) => ({ lastSave: iso(Date.parse(roster.lastSavedAt)), ageMinutes: Math.max(0, Math.floor((now - Date.parse(roster.lastSavedAt)) / 60_000)) })),
    notice: fallback ? FALLBACK_NOTICE : null,
  };
}
