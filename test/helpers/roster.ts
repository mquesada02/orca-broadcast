import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/cli.js';
import type { RecordStore, StoreOptions } from '../../src/store.js';
import type { RosterEntry, RosterSnapshot, SessionRecord, SessionScan } from '../../src/types.js';
import { fakeClock, FakeOrca, working, type FakeAgent } from './fake-orca.js';

export const T0 = Date.parse('2026-03-01T00:00:00.000Z');

/** A scan with these session records (paneKey, startTime, cwd and permission have test defaults). */
export const scanOf = (...sessions: (Pick<SessionRecord, 'sessionId'> & Partial<SessionRecord>)[]): SessionScan => ({
  sessions: sessions.map((s) => ({ paneKey: null, cwd: null, permission: null, startTime: 1, ...s })),
  unknown: [],
  heldByOthers: [],
});

/** A live Claude agent with a working state. */
export const agent = (paneKey: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({ paneKey, behavior: working, ...extra });

export interface RosterRunOptions {
  argv?: string[];
  configure?: (port: FakeOrca) => void;
  /** Start of the fake clock; the clock does not move unless the code sleeps. */
  now?: number;
  storeOptions?: StoreOptions;
}

/** Runs `roster save` (or another roster argv) once against a state folder that tests can reuse across calls. */
export async function rosterRun(stateHome: string, agents: FakeAgent[], opts: RosterRunOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const port = new FakeOrca(agents);
  opts.configure?.(port);
  const code = await main(opts.argv ?? ['roster', 'save'], { XDG_STATE_HOME: stateHome }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: false }, { port, clock: fakeClock(opts.now ?? T0), storeOptions: opts.storeOptions ?? { pid: 4242, tmpSuffix: () => 'sfx' } });
  return { code, out: out.join(''), err: err.join(''), port };
}

export const rosterFolder = (stateHome: string): string => join(stateHome, 'orca-broadcast', 'roster');

export const rosterNames = async (stateHome: string): Promise<string[]> => (await readdir(rosterFolder(stateHome)).catch(() => [] as string[])).sort();

export const readRoster = async (stateHome: string, name: string): Promise<RosterSnapshot> => JSON.parse(await readFile(join(rosterFolder(stateHome), name), 'utf8')) as RosterSnapshot;

export const readRosterText = (stateHome: string, name: string): Promise<string> => readFile(join(rosterFolder(stateHome), name), 'utf8');

/** A roster entry for seeding: an agent of a runtime that is gone (old pane key), `working` unless the test says otherwise. */
export const rosterEntry = (sessionId: string, extra: Partial<RosterEntry> = {}): RosterEntry => ({
  sessionId,
  paneKey: `old:${sessionId}`,
  repo: 'repo',
  repoId: 'repo-repo',
  worktree: `tree-${sessionId}`,
  worktreeId: `wt-${sessionId}`,
  worktreePath: `/work/tree-${sessionId}`,
  role: 'session',
  orchestrationRunIds: [],
  state: 'working',
  stateStartedAt: 1,
  savedAt: new Date(T0).toISOString(),
  ...extra,
});

/** An ISO time this many minutes before `T0`, the start of the fake clock. */
export const minutesBefore = (minutes: number): string => new Date(T0 - minutes * 60_000).toISOString();

/** The snapshot of a runtime, for seeding. Its last save is `ageMinutes` before `T0`, and its first save `lifeMinutes` before that. */
export const rosterSnapshot = (key: { bootId: string; runtimeId: string | null }, entries: RosterEntry[], ageMinutes = 5, lifeMinutes = 600): RosterSnapshot => ({
  ...key,
  firstSavedAt: minutesBefore(ageMinutes + lifeMinutes),
  lastSavedAt: minutesBefore(ageMinutes),
  entries,
});

/** A seed that saves these snapshots in order, as successive saves would. */
export const seedRosters =
  (...snapshots: RosterSnapshot[]) =>
  async (store: RecordStore): Promise<void> => {
    for (const snapshot of snapshots) await store.saveRoster(snapshot);
  };
