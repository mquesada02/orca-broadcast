import { throwIfAborted } from './abort.js';
import { isFiltered, matches, NO_FILTERS } from './filters.js';
import { buildRows, classify, finalRows, recheckHeld } from './recover-classify.js';
import { preRestartSet } from './recover-set.js';
import { autoRoster } from './roster-cmd.js';
import { sessionsByPane } from './roster.js';
import { failure, listSnapshot, liveSources, locate, resolveFilterSet, roleInfoOf, withWarnings, type Snapshot } from './shared.js';
import type { RecordStore } from './store.js';
import type { Clock, ConfirmRecover, FilterSpec, GroupFilter, OrcaPort, RecoverRow, RecoverSelf, RecoverySummary, RosterEntry, RunSummary, SessionScan, SnapshotLine } from './types.js';

const NO_ROSTER_MESSAGE = 'no roster and no open pause run; nothing to recover from';
const BROADCAST_OPEN_MESSAGE = 'a broadcast is still open; run `orca-broadcast close` and then `recover` again';
// TEMPORARY, approved by the user: `recover` has no pause-run mode yet, so it refuses while a run is open instead of ignoring the agents
// of that run. Ticket #134 (`recover` with an open pause run) removes this guard and its test.
const PAUSE_RUN_OPEN_MESSAGE = 'a pause run is open; recover with an open pause run is not available yet';

export interface RecoverDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
  /** The filters and the groups of the command line, and the folder a relative `--worktree` path is resolved from. */
  filters?: FilterSpec;
  groups?: GroupFilter[];
  cwd?: string;
  /** `ORCA_PANE_KEY`: the session that runs `recover` is never a row. */
  selfPaneKey?: string;
  /** Absent when the user passed `--yes`. */
  confirm?: ConfirmRecover;
  signal?: AbortSignal;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The scan and the boot ID are one failure for the user: no process check can be trusted.
async function scanning<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new Error(`cannot scan Claude processes: ${reasonOf(error)}`);
  }
}

interface SelfSession {
  /** The session ID of the session that runs `recover`, when the scan knows it. */
  sessionId: string | null;
  /** What the self line shows, when the entry or the live row is known. */
  display: { repo: string; worktree: string; role: RosterEntry['role'] } | null;
}

// The live row with the pane key, else the scan record with it, else (through that record's session ID) the entry. Null when none is found.
function resolveSelf(selfKey: string | undefined, snapshot: Snapshot, scan: SessionScan, preRestart: RosterEntry[]): SelfSession | null {
  if (!selfKey) return null;
  const found = locate(selfKey, snapshot.agents, snapshot.terminals);
  const live = 'gone' in found ? undefined : found.row;
  const record = sessionsByPane(scan).get(selfKey);
  if (!live && !record) return null;
  const sessionId = record?.sessionId ?? null;
  const entry = sessionId === null ? undefined : preRestart.find((e) => e.sessionId === sessionId);
  const display = entry ? { repo: entry.repo, worktree: entry.worktree, role: entry.role } : live ? { repo: live.repo, worktree: live.worktree, role: roleInfoOf(snapshot.roles, selfKey).role } : null;
  return { sessionId, display };
}

const emptyRecovery = (snapshots: SnapshotLine[]): RecoverySummary => ({ rows: [], snapshots, self: null });

const workerItem = (row: RecoverRow): string => `${row.repo}/${row.worktree} (dispatch ${row.dispatchId ?? 'unknown'})`;

const NOT_DONE = new Set(['pending', 'gone', 'no-coordinator', 'failed']);

/**
 * `recover` after a crash: reads the roster from before the restart, classifies every agent against the live fleet and the scan, shows
 * the report and asks once. In this version a yes starts and sends nothing: each row that a restart or a prompt would handle ends
 * `pending`, reason `timed-out`.
 */
export function recover(timeoutMs: number, deps: RecoverDeps): Promise<RunSummary> {
  return withWarnings(async (warnings) => {
    // The snapshot lines read so far, for an error summary.
    const read: { snapshots: SnapshotLine[] } = { snapshots: [] };
    try {
      return await run(timeoutMs, deps, warnings, read);
    } catch (error) {
      return { ...failure(error, null), recovery: emptyRecovery(read.snapshots) };
    }
  });
}

async function run(timeoutMs: number, deps: RecoverDeps, warnings: string[], read: { snapshots: SnapshotLine[] }): Promise<RunSummary> {
  const { port, clock, store, signal } = deps;
  const startedAt = clock.now();
  throwIfAborted(signal);

  // The read-only check: the repairing load would rewrite a broadcast that is open beside a pause run.
  const open = await store.peekOpen();
  if (open.pause) throw new Error(PAUSE_RUN_OPEN_MESSAGE);
  if (open.broadcast) throw new Error(BROADCAST_OPEN_MESSAGE);

  const snapshot = await listSnapshot({ port, clock, signal });
  throwIfAborted(signal);

  const rosters = await store.loadRosters();
  if (rosters.length === 0) throw new Error(NO_ROSTER_MESSAGE);
  const bootId = await scanning(() => port.bootId());
  const preRestart = preRestartSet(rosters, { bootId, runtimeId: snapshot.runtimeId }, clock.now());
  read.snapshots = preRestart.snapshots;
  if (preRestart.notice) warnings.push(preRestart.notice);

  const scan = await scanning(() => port.scanSessions());
  throwIfAborted(signal);
  // After the pre-restart set was read: a save in the live runtime must not drop the dead agents before they are read.
  await autoRoster({ port, clock, store, signal }, warnings).start(snapshot, scan);
  throwIfAborted(signal);

  const self = resolveSelf(deps.selfPaneKey, snapshot, scan, preRestart.entries);
  const entries = preRestart.entries.filter((entry) => entry.sessionId !== self?.sessionId);
  const filters = deps.filters ?? NO_FILTERS;
  const set = resolveFilterSet(filters, isFiltered(filters, deps.groups) ? await liveSources(snapshot, { port, clock, signal }) : null, entries, deps.cwd, deps.groups);
  const recoverySet = entries.filter((entry) => matches(set, entry));
  if (recoverySet.length === 0) return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [], recovery: emptyRecovery(read.snapshots) };

  const items = classify(recoverySet, snapshot, scan);
  const scanFailed = await recheckHeld(items, { port, clock, signal, deadline: startedAt + timeoutMs });
  const classified = buildRows(items, { selfSessionId: self?.sessionId ?? null, everyone: preRestart.entries, scanFailed });

  const { plan } = classified;
  let answer: 'declined' | 'timed-out' = 'timed-out';
  if (plan.restarts.length + plan.prompts.length + plan.leaves.length > 0 && deps.confirm && !(await deps.confirm(plan, signal))) answer = 'declined';
  throwIfAborted(signal);

  const rows = finalRows(classified, answer);
  const selfLine: RecoverSelf | null = self?.display ? { ...self.display, missingWorkers: rows.filter((row) => row.reason === 'coordinator-is-self').map(workerItem) } : null;
  return { outcome: 'done', exitCode: rows.some((row) => NOT_DONE.has(row.status)) ? 1 : 0, run: null, error: null, rows: [], recovery: { rows, snapshots: read.snapshots, self: selfLine } };
}
