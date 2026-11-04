import { throwIfAborted } from './abort.js';
import { isFiltered, matches, NO_FILTERS } from './filters.js';
import { buildRows, classify, finalRows, recheckHeld, type Classified } from './recover-classify.js';
import { recoveryRowOf, releaseRecovery } from './recover-record.js';
import { preRestartSet } from './recover-set.js';
import { startAgents, waitForAppearance, type StartDeps } from './recover-start.js';
import { autoRoster, type AutoRoster } from './roster-cmd.js';
import { sessionsByPane } from './roster.js';
import { clearPid, failure, iso, listSnapshot, liveSources, locate, randomToken, recordId, resolveFilterSet, roleInfoOf, setPid, withWarnings, type Snapshot } from './shared.js';
import type { RecordStore } from './store.js';
import type { Clock, ConfirmRecover, FilterSpec, GroupFilter, OrcaPort, RecoverRow, RecoverSelf, RecoveryRecord, RecoveryRow, RecoverySummary, RosterEntry, RunSummary, SessionScan, SnapshotLine } from './types.js';

const NO_ROSTER_MESSAGE = 'no roster and no open pause run; nothing to recover from';
const BROADCAST_OPEN_MESSAGE = 'a broadcast is still open; run `orca-broadcast close` and then `recover` again';
// TEMPORARY, approved by the user: `recover` has no pause-run mode yet, so it refuses while a run is open instead of ignoring the agents
// of that run. Ticket #134 (`recover` with an open pause run) removes this guard and its test.
const PAUSE_RUN_OPEN_MESSAGE = 'a pause run is open; recover with an open pause run is not available yet';
// TEMPORARY, approved by the user: `recover` cannot continue an open recovery record yet (the re-run is ticket #133) and nothing else
// closes one yet (ticket #132), so it refuses instead of writing a second open record. Ticket #133 removes this guard and its test.
const RECOVERY_OPEN_MESSAGE = 'a recovery is open; recover with an open recovery record is not available yet';

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
  /** Makes the token of the recovery record; `randomToken` when omitted. */
  newToken?: () => string;
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

const emptyRecovery = (snapshots: SnapshotLine[]): RecoverySummary => ({ rows: [], snapshots, self: null, record: null });

const workerItem = (row: RecoverRow): string => `${row.repo}/${row.worktree} (dispatch ${row.dispatchId ?? 'unknown'})`;

const NOT_DONE = new Set(['pending', 'gone', 'no-coordinator', 'failed']);

/**
 * `recover` after a crash: reads the roster from before the restart, classifies every agent against the live fleet and the scan, shows
 * the report and asks once. After a yes it writes the recovery record, restarts every missing non-worker agent and waits for each one to
 * appear. Prompts are not built yet: a row that a prompt would handle ends `pending`, reason `timed-out`.
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
  if (open.recovery) throw new Error(RECOVERY_OPEN_MESSAGE);
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
  const roster = autoRoster({ port, clock, store, signal }, warnings);
  await roster.start(snapshot, scan);
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
  const due = plan.restarts.length + plan.prompts.length + plan.leaves.length > 0;
  let declined = false;
  // The time the confirmation waited does not count toward `--timeout`.
  const asked = clock.now();
  if (due && deps.confirm && !(await deps.confirm(plan, signal))) declined = true;
  const deadline = startedAt + timeoutMs + (clock.now() - asked);
  throwIfAborted(signal);

  const rows = finalRows(classified, declined ? 'declined' : 'timed-out');
  const selfLine: RecoverSelf | null = self?.display ? { ...self.display, missingWorkers: rows.filter((row) => row.reason === 'coordinator-is-self').map(workerItem) } : null;
  if (declined || !due) return { outcome: 'done', exitCode: exitCodeOf(rows), run: null, error: null, rows: [], recovery: { rows, snapshots: read.snapshots, self: selfLine, record: null } };

  return execute({ deps, warnings, classified, snapshotKey: preRestart.key, liveRuntime: { bootId, runtimeId: snapshot.runtimeId }, snapshots: read.snapshots, selfLine, deadline, roster });
}

const exitCodeOf = (rows: { status: RecoverRow['status'] }[]): 0 | 1 => (rows.some((row) => NOT_DONE.has(row.status)) ? 1 : 0);

interface Execution {
  deps: RecoverDeps;
  warnings: string[];
  classified: Classified;
  snapshotKey: RecoveryRecord['snapshotKey'];
  liveRuntime: RecoveryRecord['liveRuntime'];
  snapshots: SnapshotLine[];
  selfLine: RecoverSelf | null;
  deadline: number;
  roster: AutoRoster;
}

// The row as the record stores it: a row that a restart, a prompt or a leave would handle is `pending`, reason `timed-out`, until its turn comes.
function recordRows({ rows }: Classified): RecoveryRow[] {
  return rows.map((row) => {
    const pending = row.restart || row.prompt || row.leave;
    return { ...row.entry, status: pending ? 'pending' : row.status, reason: pending ? 'timed-out' : row.reason, promptDue: row.prompt };
  });
}

/** After a yes with something to start or send: the record, the starts, the appearance wait and the end. */
async function execute({ deps, warnings, classified, snapshotKey, liveRuntime, snapshots, selfLine, deadline, roster }: Execution): Promise<RunSummary> {
  const { port, clock, store, signal } = deps;
  const token = (deps.newToken ?? randomToken)();
  const now = clock.now();
  const record: RecoveryRecord = { id: recordId(now, token), token, createdAt: iso(now), status: 'open', snapshotKey, liveRuntime, snapshots, rows: recordRows(classified) };
  const summaryOf = (): RecoverySummary => ({ rows: record.rows.map(recoveryRowOf), snapshots, self: selfLine, record });
  const save = (): Promise<void> => store.saveRecovery(record);

  // Before the first start: nothing was started if this fails.
  setPid(record, store);
  try {
    await save();
    await store.setCurrent('recovery', record.id);
  } catch (error) {
    clearPid(record);
    await save().catch(() => {});
    return { ...failure(error, null), recovery: summaryOf() };
  }

  let summary: RunSummary;
  try {
    const startDeps: StartDeps = { port, clock, signal, record, save, deadline, warnings };
    const restarts = record.rows.filter((_, index) => (classified.rows[index] as Classified['rows'][number]).restart);
    const started = await startAgents(restarts, startDeps);
    if (started.count > 0) await waitForAppearance(started, startDeps);
    // The end snapshot comes before the record closes: a failed listing leaves the record open like any other.
    if (started.count > 0) await roster.end(await listSnapshot({ port, clock, signal }));
    releaseRecovery(record);
    await save();
    if (record.status === 'closed') await store.clearCurrent('recovery', record.id);
    summary = { outcome: 'done', exitCode: exitCodeOf(record.rows), run: null, error: null, rows: [], recovery: summaryOf() };
  } catch (error) {
    summary = { ...failure(error, null), recovery: summaryOf() };
    try {
      clearPid(record);
      await save();
    } catch (saveError) {
      if (summary.exitCode !== 130) summary = { ...failure(saveError, null), recovery: summaryOf() };
    }
  }
  return summary;
}
