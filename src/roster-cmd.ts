import { buildRoster } from './roster.js';
import { listSnapshot, type Snapshot } from './shared.js';
import { rosterFileId, type RecordStore } from './store.js';
import type { Clock, OrcaPort } from './types.js';

const ROSTER_SUBCOMMANDS = ['save'] as const;
export type RosterSubcommand = (typeof ROSTER_SUBCOMMANDS)[number];
export const isRosterSubcommand = (value: string | undefined): value is RosterSubcommand => ROSTER_SUBCOMMANDS.some((name) => name === value);

export interface RosterDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
}

export type RosterResult = { outcome: 'saved'; agents: number } | { outcome: 'skipped'; reason: string };

// One scan, then one write of the roster of `snapshot`; returns the number of entries written. It takes no listing.
// A skip before the write never changes the saved snapshots. When `signal` is aborted after the scan, nothing is written and the result is null.
async function saveRosterOf(snapshot: Snapshot, { port, clock, store }: RosterDeps, signal?: AbortSignal): Promise<number | null> {
  const scan = await port.scanSessions();
  if (signal?.aborted) return null;
  const bootId = await port.bootId();
  const rosters = await store.loadRosters();
  const file = rosterFileId(bootId, snapshot.runtimeId);
  const previous = rosters.find((roster) => rosterFileId(roster.bootId, roster.runtimeId) === file) ?? null;
  const roster = buildRoster(snapshot, scan, previous, bootId, clock.now());
  if (signal?.aborted) return null;
  await store.saveRoster(roster);
  return roster.entries.length;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// `roster save`: one listing snapshot, one scan, one file. It sends nothing, takes no lock and touches only `roster/`.
// Every failure from the first listing to the write is a skip.
export async function runRosterSave(deps: RosterDeps): Promise<RosterResult> {
  try {
    const agents = await saveRosterOf(await listSnapshot(deps), deps);
    return { outcome: 'saved', agents: agents as number };
  } catch (error) {
    return { outcome: 'skipped', reason: reasonOf(error) };
  }
}

export interface AutoRosterDeps extends RosterDeps {
  signal?: AbortSignal;
}

/**
 * The automatic saves of one `broadcast`, `pause` or `resume` run. They take no listing: `start` saves the first snapshot of the run,
 * `end` saves the newest one unless it is the start snapshot. A failed save adds a warning and never throws; a run that has seen
 * its abort signal saves nothing.
 */
export interface AutoRoster {
  start(snapshot: Snapshot): Promise<void>;
  end(newest: Snapshot | null): Promise<void>;
}

export function autoRoster(deps: AutoRosterDeps, warnings: string[]): AutoRoster {
  let started: Snapshot | null = null;
  const save = async (snapshot: Snapshot): Promise<void> => {
    if (deps.signal?.aborted) return;
    try {
      await saveRosterOf(snapshot, deps, deps.signal);
    } catch (error) {
      warnings.push(`roster not saved: ${reasonOf(error)}`);
    }
  };
  return {
    async start(snapshot) {
      started = snapshot;
      await save(snapshot);
    },
    async end(newest) {
      if (started === null || newest === null || newest === started) return;
      await save(newest);
    },
  };
}
