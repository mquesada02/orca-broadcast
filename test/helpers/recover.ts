import { fakeClock, type FakeAgent, type FakeOrca } from './fake-orca.js';
import { rosterEntry, rosterSnapshot, scanOf, seedRosters, T0 } from './roster.js';
import { runCli, type RunCliOptions } from './run-cli.js';
import type { RecoverRow, RecoveryRecord, RosterEntry, SessionScan, SnapshotLine } from '../../src/types.js';

/** The runtime that the roster was saved in: the fake port runs in `boot-1` and `runtime-1`, so this one is a runtime that is gone. */
export const GONE = { bootId: 'boot-0', runtimeId: 'runtime-0' };

export interface RecoverOptions extends RunCliOptions {
  /** The scan by scan call number, or one scan for every call. Empty when omitted. */
  scan?: SessionScan | ((scanCall: number) => SessionScan);
  /** The age in minutes of the seeded roster (5 when omitted). */
  ageMinutes?: number;
  /** Runs each time the fake clock sleeps. */
  onSleep?: () => void;
}

/** Runs `recover` once with a roster of the runtime that is gone, seeded in the state folder. */
export async function recoverRun(argv: string[], agents: FakeAgent[], entries: RosterEntry[], opts: RecoverOptions = {}) {
  const clock = fakeClock(T0);
  const { scan, ageMinutes, onSleep, ...rest } = opts;
  if (onSleep) clock.onSleep = onSleep;
  const result = await runCli(['recover', ...argv], agents, {
    clock,
    seed: seedRosters(rosterSnapshot(GONE, entries, ageMinutes)),
    ...rest,
    configure: (port: FakeOrca) => {
      port.scanAt = typeof scan === 'function' ? scan : () => scan ?? scanOf();
      rest.configure?.(port);
    },
  });
  return { ...result, clock };
}

export interface RecoverJson {
  command: string;
  outcome: string;
  exitCode: number;
  run: null;
  record: RecoveryRecord | null;
  error: string | null;
  rows: RecoverRow[];
  snapshots: SnapshotLine[];
  cleared: { repo: string; worktree: string }[];
  warnings: string[];
}

export const parseJson = (out: string): RecoverJson => JSON.parse(out) as RecoverJson;

/** `status` and `reason` of each JSON row by session ID. */
export const resultsOf = (out: string): Record<string, string> =>
  Object.fromEntries(parseJson(out).rows.map((row) => [row.sessionId, row.reason === null ? row.status : `${row.status}/${row.reason}`]));

/** An entry whose agent was `done`, so no prompt is due for it. */
export const doneEntry = (sessionId: string, extra: Partial<RosterEntry> = {}): RosterEntry => rosterEntry(sessionId, { state: 'done', ...extra });
