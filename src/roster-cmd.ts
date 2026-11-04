import { buildRoster } from './roster.js';
import { listSnapshot } from './shared.js';
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

// `roster save`: one listing snapshot, one scan, one file. It sends nothing, takes no lock and touches only `roster/`.
// Every failure from the first listing to the write is a skip, and a skip never changes the saved snapshots.
export async function runRosterSave({ port, clock, store }: RosterDeps): Promise<RosterResult> {
  try {
    const snapshot = await listSnapshot({ port, clock });
    const scan = await port.scanSessions();
    const bootId = await port.bootId();
    const rosters = await store.loadRosters();
    const file = rosterFileId(bootId, snapshot.runtimeId);
    const previous = rosters.find((roster) => rosterFileId(roster.bootId, roster.runtimeId) === file) ?? null;
    const roster = buildRoster(snapshot, scan, previous, bootId, clock.now());
    await store.saveRoster(roster);
    return { outcome: 'saved', agents: roster.entries.length };
  } catch (error) {
    return { outcome: 'skipped', reason: error instanceof Error ? error.message : String(error) };
  }
}
