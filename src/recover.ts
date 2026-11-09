import { throwIfAborted } from './abort.js';
import { isFiltered, matches, NO_FILTERS } from './filters.js';
import { applyStarts, buildRows, classify, finalRows, recheckHeld, type Classified } from './recover-classify.js';
import { recoveryRowOf, releaseRecovery } from './recover-record.js';
import { planRerun } from './recover-rerun.js';
import { isSameRestart, leftWorkers, retakeSet } from './recover-retake.js';
import { preRestartSet, sameRuntime, type PreRestartSet } from './recover-set.js';
import { workerItem } from './recover-prompt.js';
import { startAgents, type StartDeps } from './recover-start.js';
import { needsWait, resolveWorkers, settle } from './recover-wait.js';
import { autoRoster, type AutoRoster } from './roster-cmd.js';
import { paneOfSession, sessionsByPane } from './roster.js';
import { clearPid, failure, iso, listSnapshot, liveSources, locate, randomToken, recordId, resolveFilterSet, roleInfoOf, setPid, withWarnings, type Snapshot } from './shared.js';
import type { RecordStore } from './store.js';
import type { Clock, ConfirmRecover, FilterSpec, GroupFilter, OrcaPort, RecoverRow, RecoverSelf, RecoveryRecord, RecoveryRow, RecoverySummary, RosterEntry, RunSummary, SessionScan, SnapshotLine } from './types.js';

const NO_ROSTER_MESSAGE = 'no roster and no open pause run; nothing to recover from';
const BROADCAST_OPEN_MESSAGE = 'a broadcast is still open; run `orca-broadcast close` and then `recover` again';
// TEMPORARY, approved by the user: `recover` has no pause-run mode yet, so it refuses while a run is open instead of ignoring the agents
// of that run. Ticket #134 (`recover` with an open pause run) removes this guard and its test.
const PAUSE_RUN_OPEN_MESSAGE = 'a pause run is open; recover with an open pause run is not available yet';
const BROKEN_STATE_MESSAGE = 'a recovery and a broadcast are both open; run `orca-broadcast close` and then `recover` again';
const FLEET_RESTARTED_MESSAGE = 'the fleet restarted again; `close` the recovery and run `recover` again';

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

const NOT_DONE = new Set(['pending', 'gone', 'no-coordinator', 'failed']);

/**
 * `recover` after a crash: reads the roster from before the restart, classifies every agent against the live fleet and the scan, shows
 * the report and asks once. After a yes it writes the recovery record, restarts every missing non-worker agent and waits for each one to
 * appear. It then sends the continue prompt to each agent that is due one, coordinators first, and waits for each ack.
 * With an open recovery record it continues that record instead (a re-run, same token); after a recovery that closed by itself, a
 * later run from the same restart takes again only its `failed`, `gone` and `no-coordinator` rows (a retake, new token).
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
  if (open.recovery && open.broadcast) throw new Error(BROKEN_STATE_MESSAGE);
  if (open.broadcast) throw new Error(BROADCAST_OPEN_MESSAGE);

  const snapshot = await listSnapshot({ port, clock, signal });
  throwIfAborted(signal);

  // An open recovery record is continued (a re-run); it keeps its own snapshot lines and never reads the roster.
  const saved = open.recovery?.record ?? null;
  let preRestart: PreRestartSet | null = null;
  let retake: RecoveryRecord | null = null;
  let bootId: string;
  if (saved) {
    bootId = await scanning(() => port.bootId());
    if (!sameRuntime(saved.liveRuntime, { bootId, runtimeId: snapshot.runtimeId })) throw new Error(FLEET_RESTARTED_MESSAGE);
    read.snapshots = saved.snapshots;
  } else {
    const rosters = await store.loadRosters();
    if (rosters.length === 0) throw new Error(NO_ROSTER_MESSAGE);
    bootId = await scanning(() => port.bootId());
    preRestart = preRestartSet(rosters, { bootId, runtimeId: snapshot.runtimeId }, clock.now());
    read.snapshots = preRestart.snapshots;
    if (preRestart.notice) warnings.push(preRestart.notice);
    // A recovery that closed by itself from this same restart: only its failed, gone and no-coordinator rows are taken again.
    const closed = await store.loadNewestClosedRecovery();
    if (closed && isSameRestart(closed, preRestart.key, { bootId, runtimeId: snapshot.runtimeId })) retake = closed;
  }

  const scan = await scanning(() => port.scanSessions());
  throwIfAborted(signal);
  // After the pre-restart set was read: a save in the live runtime must not drop the dead agents before they are read.
  const roster = autoRoster({ port, clock, store, signal }, warnings);
  await roster.start(snapshot, scan);
  throwIfAborted(signal);

  const filters = deps.filters ?? NO_FILTERS;
  const sources = async () => (isFiltered(filters, deps.groups) ? await liveSources(snapshot, { port, clock, signal }) : null);
  if (saved) {
    const self = resolveSelf(deps.selfPaneKey, snapshot, scan, saved.rows);
    const set = resolveFilterSet(filters, await sources(), saved.rows, deps.cwd, deps.groups);
    const scope = saved.rows.filter((row) => row.sessionId !== self?.sessionId && matches(set, row));
    if (scope.length === 0) return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [], recovery: emptyRecovery(read.snapshots) };

    const plan = await planRerun({ port, clock, signal, deadline: startedAt + timeoutMs, snapshot, scan, selfSessionId: self?.sessionId ?? null, rows: saved.rows, scope }, (classified) => recordRows(classified).rows);
    const selfLine = selfLineOf(self, scope);
    const asked = clock.now();
    const declined = dueOf(plan.classified) && deps.confirm !== undefined && !(await deps.confirm(plan.classified.plan, signal));
    const deadline = startedAt + timeoutMs + (clock.now() - asked);
    throwIfAborted(signal);
    if (declined) return { outcome: 'done', exitCode: exitCodeOf(plan.declined), run: null, error: null, rows: [], recovery: { rows: plan.declined, snapshots: saved.snapshots, self: selfLine, record: null } };
    return execute({ deps, warnings, record: saved, restarts: plan.restarts, earlier: plan.earlier, rows: scope, snapshots: saved.snapshots, selfLine, deadline, roster, scan: plan.scan, panes: plan.panes });
  }

  const base = retake ? retakeSet(retake) : null;
  const pool = base ? base.entries : (preRestart as PreRestartSet).entries;
  const self = resolveSelf(deps.selfPaneKey, snapshot, scan, pool);
  const entries = pool.filter((entry) => entry.sessionId !== self?.sessionId);
  const set = resolveFilterSet(filters, await sources(), entries, deps.cwd, deps.groups);
  const recoverySet = entries.filter((entry) => matches(set, entry));
  // A coordinator that a retake may bring in is no row of its own: with no retaken row in the set there is nothing to retake.
  if (recoverySet.length === 0 || (base && recoverySet.every((entry) => base.bringIn.has(entry.sessionId)))) return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [], recovery: emptyRecovery(read.snapshots) };

  const found = classify(recoverySet, snapshot, scan);
  for (const item of found) {
    const start = base?.starts.get(item.entry.sessionId);
    if (start !== undefined) item.startedAt = start;
    if (base?.bringIn.has(item.entry.sessionId)) item.bringIn = true;
  }
  // A coordinator is brought in only while it is live.
  const items = found.filter((item) => !item.bringIn || item.standing === 'restored');
  const { scanFailed, scan: rechecked } = await recheckHeld(items, { port, clock, signal, deadline: startedAt + timeoutMs });
  applyStarts(items, clock.now());
  // The rows that are live now (a held row that appeared during the re-check included), and the pane that holds each one.
  const panes = new Map<string, string>();
  for (const { entry, standing } of items) {
    const pane = standing === 'restored' ? ((rechecked && paneOfSession(rechecked, entry.sessionId)) ?? paneOfSession(scan, entry.sessionId)) : undefined;
    if (pane !== undefined) panes.set(entry.sessionId, pane);
  }
  const dropped = new Set(found.filter((item) => item.bringIn && item.standing !== 'restored').map((item) => item.entry.sessionId));
  const classified = buildRows(items, { selfSessionId: self?.sessionId ?? null, everyone: pool.filter((entry) => !dropped.has(entry.sessionId)), scanFailed });
  if (retake) addExtraWorkers(classified, retake, snapshot, rechecked ?? scan);

  const { plan } = classified;
  const due = dueOf(classified);
  let declined = false;
  // The time the confirmation waited does not count toward `--timeout`.
  const asked = clock.now();
  if (due && deps.confirm && !(await deps.confirm(plan, signal))) declined = true;
  const deadline = startedAt + timeoutMs + (clock.now() - asked);
  throwIfAborted(signal);

  const rows = finalRows(classified, declined ? 'declined' : 'timed-out');
  const selfLine = selfLineOf(self, rows);
  // A start that an earlier run recorded and that is still awaited needs a record and a wait, even when nothing else is due.
  if (declined || (!due && !classified.rows.some((row) => row.awaiting))) return { outcome: 'done', exitCode: exitCodeOf(rows), run: null, error: null, rows: [], recovery: { rows, snapshots: read.snapshots, self: selfLine, record: null } };

  const now = clock.now();
  const token = (deps.newToken ?? randomToken)();
  const { rows: recordRowList, restarts } = recordRows(classified);
  const record: RecoveryRecord = { id: recordId(now, token), token, createdAt: iso(now), status: 'open', snapshotKey: (preRestart as PreRestartSet).key, liveRuntime: { bootId, runtimeId: snapshot.runtimeId }, snapshots: read.snapshots, rows: recordRowList };
  return execute({ deps, warnings, record, restarts, earlier: recordRowList.filter((row) => row.status === 'pending' && row.reason === 'awaiting-start'), rows: recordRowList, snapshots: read.snapshots, selfLine, deadline, roster, scan: rechecked ?? scan, panes });
}

const exitCodeOf = (rows: { status: RecoverRow['status'] }[]): 0 | 1 => (rows.some((row) => NOT_DONE.has(row.status)) ? 1 : 0);

const dueOf = ({ plan }: Classified): boolean => plan.restarts.length + plan.prompts.length + plan.leaves.length > 0;

// The self line of a re-run: the missing workers are the scope rows that name the self session as their coordinator.
const selfLineOf = (self: SelfSession | null, rows: { reason: RecoverRow['reason']; repo: string; worktree: string; dispatchId?: string | null }[]): RecoverSelf | null =>
  self?.display ? { ...self.display, missingWorkers: rows.filter((row) => row.reason === 'coordinator-is-self').map(workerItem) } : null;

// A coordinator that gets the list of a missing worker also lists the workers that its earlier record left to it and that are still missing.
function addExtraWorkers(classified: Classified, earlier: RecoveryRecord, snapshot: Snapshot, scan: SessionScan): void {
  const listed = new Set(classified.rows.filter((row) => row.leave).map((row) => (row.coordinator as RosterEntry).sessionId));
  for (const row of classified.rows) {
    if (!listed.has(row.entry.sessionId)) continue;
    const missing = classify(leftWorkers(earlier, row.entry.sessionId), snapshot, scan).filter((item) => item.standing === 'free');
    if (missing.length > 0) row.extraWorkers = missing.map(({ entry }) => ({ repo: entry.repo, worktree: entry.worktree, dispatchId: entry.dispatchId ?? null }));
  }
}

interface Execution {
  deps: RecoverDeps;
  warnings: string[];
  /** The record to work on: a new one, or the open one of a re-run. */
  record: RecoveryRecord;
  /** The rows of the record that a start is due for. */
  restarts: RecoveryRow[];
  /** The rows that wait for a start that an earlier run recorded. */
  earlier: RecoveryRow[];
  /** The rows this run works on: every row of a new record, or the rows in scope of a re-run. */
  rows: RecoveryRow[];
  snapshots: SnapshotLine[];
  selfLine: RecoverSelf | null;
  deadline: number;
  roster: AutoRoster;
  /** The newest scan of the run. */
  scan: SessionScan;
  /** Session ID to the pane of each agent that is live when the starts begin. */
  panes: Map<string, string>;
}

// The row as the record stores it: a row that a restart, a prompt or a leave would handle is `pending`, reason `timed-out`, until its turn comes.
function recordRows({ rows }: Classified): { rows: RecoveryRow[]; restarts: RecoveryRow[] } {
  const restarts: RecoveryRow[] = [];
  const recordRowsOut = rows.map((row) => {
    const pending = row.restart || row.prompt || row.leave;
    const recordRow: RecoveryRow = {
      ...row.entry,
      status: row.awaiting || pending ? 'pending' : row.status,
      reason: row.awaiting ? 'awaiting-start' : pending ? 'timed-out' : row.reason,
      promptDue: row.prompt,
      messagePending: row.prompt,
      baseline: null,
      ...(row.leave ? { listDue: true as const } : {}),
      ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
      ...(row.extraWorkers ? { extraWorkers: row.extraWorkers } : {}),
    };
    if (row.restart) restarts.push(recordRow);
    return recordRow;
  });
  return { rows: recordRowsOut, restarts };
}

/** After a yes with something to start, send or wait on: the record, the starts, the appearance and prompt loop and the end. */
async function execute({ deps, warnings, record, restarts, earlier, rows, snapshots, selfLine, deadline, roster, scan, panes }: Execution): Promise<RunSummary> {
  const { port, clock, store, signal } = deps;
  const summaryOf = (): RecoverySummary => ({ rows: rows.map(recoveryRowOf), snapshots, self: selfLine, record });
  const save = (): Promise<void> => store.saveRecovery(record);

  // Before the first start: nothing was started if this fails.
  setPid(record, store);
  let firstSaveWorked = false;
  try {
    await save();
    firstSaveWorked = true;
    await store.setCurrent('recovery', record.id);
  } catch (error) {
    clearPid(record);
    if (firstSaveWorked) await save().catch(() => {});
    return { ...failure(error, null), recovery: summaryOf() };
  }

  let summary: RunSummary;
  try {
    const startDeps: StartDeps = { port, clock, signal, record, save, deadline, warnings };
    const started = await startAgents(restarts, startDeps);
    for (const [sessionId, pane] of started.panes) panes.set(sessionId, pane);
    if (started.count > 0 || rows.some(needsWait)) await settle(started, { ...startDeps, token: record.token, scan, panes, rows, earlier });
    // The end snapshot comes before the record closes: a failed listing leaves the record open like any other.
    if (started.count > 0) await roster.end(await listSnapshot({ port, clock, signal }));
    resolveWorkers(rows);
    releaseRecovery(record);
    await save();
    if (record.status === 'closed') await store.clearCurrent('recovery', record.id);
    summary = { outcome: 'done', exitCode: exitCodeOf(rows), run: null, error: null, rows: [], recovery: summaryOf() };
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
