import { compare } from './recover-classify.js';
import { recoveryRowOf } from './recover-record.js';
import type { RecordStore } from './store.js';
import type { AgentRecord, MissingWorker, RecoverRow, RecoveryRecord, RecoveryRow, RosterEntry, Run, RunRecoveryRow, RuntimeKey } from './types.js';

// Pause-run mode of `recover`: the parts that read and write the open pause run. The classification, the starts and the wait are shared with crash mode.

/** The two things that differ between the modes in the shared run (`execute` in `src/recover.ts`): where the rows are written, and what ends the run. */
export interface Mode {
  /** The ack token of the prompts; pause-run mode sends none. */
  token: string;
  /** Writes what must be on disk before the first start. A failure means nothing was started. */
  begin(): Promise<void>;
  /** Writes the record or the run. */
  save(): Promise<void>;
  /** After the starts and the wait: decides the workers, closes or completes what is written, and writes it. */
  finish(): Promise<void>;
  /** After a failure: writes the rows as they are. */
  onError(): Promise<void>;
  /** The rows the table and the `--json` line show. */
  table(): RecoverRow[];
  /** The recovery record this run writes; absent in pause-run mode. */
  record?: RecoveryRecord;
}

/** An agent of the run, with the session ID that `recover` works with. */
export interface Member {
  record: AgentRecord;
  sessionId: string;
}

export interface RunMembers {
  /** The recovery set entries of the agents of the run: the roster entry when the roster has one, else an entry made from the run record. */
  entries: RosterEntry[];
  members: Member[];
  /** The agents of the run that have no session ID, not even through the `paneKey` of a roster entry. */
  withoutSessionId: AgentRecord[];
  sessionIds: Set<string>;
}

// The roster fields of a run agent that the roster does not know: nothing is known of its state, its coordinator or its dispatch.
const fieldsOfRecord = (record: AgentRecord, savedAt: string) => ({
  paneKey: record.paneKey,
  repo: record.repo,
  repoId: record.repoId,
  worktree: record.worktree,
  worktreeId: record.worktreeId,
  worktreePath: record.worktreePath,
  role: record.role,
  orchestrationRunIds: record.orchestrationRunIds,
  state: 'done' as const,
  stateStartedAt: 0,
  savedAt,
});

const entryOfRecord = (record: AgentRecord, sessionId: string, savedAt: string): RosterEntry => ({
  sessionId,
  ...fieldsOfRecord(record, savedAt),
  ...(record.permission === undefined ? {} : { permission: record.permission }),
});

/** The agents of the run: its pending records. A record without a session ID takes it from the pre-restart entry with the same `paneKey`. */
export function runMembers(run: Run, preRestart: RosterEntry[]): RunMembers {
  const bySession = new Map(preRestart.map((entry) => [entry.sessionId, entry]));
  const byPane = new Map<string, RosterEntry>();
  for (const entry of preRestart) if (!byPane.has(entry.paneKey)) byPane.set(entry.paneKey, entry);
  const result: RunMembers = { entries: [], members: [], withoutSessionId: [], sessionIds: new Set() };
  for (const record of run.agents.filter((agent) => agent.resumeStatus === 'pending')) {
    const sessionId = record.sessionId ?? byPane.get(record.paneKey)?.sessionId;
    if (sessionId === undefined) {
      result.withoutSessionId.push(record);
      continue;
    }
    const known = bySession.get(sessionId);
    const entry = known ? { ...known, ...(known.permission === undefined && record.permission !== undefined ? { permission: record.permission } : {}) } : entryOfRecord(record, sessionId, run.startedAt);
    result.entries.push(entry);
    result.members.push({ record, sessionId });
    result.sessionIds.add(sessionId);
  }
  return result;
}

/** The recovery set: the pre-restart entries, with each agent of the run in place of its roster entry. */
export function poolOf(preRestart: RosterEntry[], members: RunMembers): RosterEntry[] {
  const pool = new Map(preRestart.map((entry) => [entry.sessionId, entry]));
  for (const entry of members.entries) pool.set(entry.sessionId, entry);
  return [...pool.values()];
}

/** The row of a run agent that has no session ID: it is never classified, started or waited on. */
export const noSessionRow = (record: AgentRecord, savedAt: string): RunRecoveryRow => ({
  sessionId: null,
  ...fieldsOfRecord(record, savedAt),
  status: 'failed',
  reason: 'no-session-id',
  promptDue: false,
  messagePending: false,
  baseline: null,
});

const rank = (role: RosterEntry['role']): number => (role === 'coordinator' ? 0 : 1);
// A null session ID sorts after every other.
const compareId = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : compare(a, b));

/** The order of the table: coordinators first; each group by repo, worktree, session ID (a null one last) and pane key. */
export function inTableOrder<T>(items: T[], key: (item: T) => { role: RosterEntry['role']; repo: string; worktree: string; sessionId: string | null; paneKey: string }): T[] {
  return [...items].sort((x, y) => {
    const a = key(x);
    const b = key(y);
    return rank(a.role) - rank(b.role) || compare(a.repo, b.repo) || compare(a.worktree, b.worktree) || compareId(a.sessionId, b.sessionId) || compare(a.paneKey, b.paneKey);
  });
}

export interface PauseState {
  store: RecordStore;
  run: Run;
  /** The key of the newest snapshot used, or the live runtime when there is no roster. */
  snapshotKey: RuntimeKey;
  liveRuntime: RuntimeKey;
  /** The rows of this `recover` that the shared run works on. */
  rows: RecoveryRow[];
  withoutSessionId: RunRecoveryRow[];
  /** The stored rows that this `recover` did not take again; they keep their outcome. */
  untouched: RunRecoveryRow[];
  /** The stored starts of agents that have no row in this `recover`: they stay, so no agent is started twice. */
  carriedStarts: { sessionId: string; startedAt: string }[];
  members: Member[];
  selfSessionId: string | null;
}

/**
 * After the wait: a missing worker is `left-to-coordinator` when its coordinator is neither `failed` nor `pending`; it stays `pending`
 * (and is taken again with its coordinator) while that row is `pending`; it is `no-coordinator` when the coordinator row is `failed`
 * or there is none. The list of the worker is stored in the run, not sent, so `listDue` stays only on a worker that is still `pending`.
 */
function decideWorkers(rows: RecoveryRow[], all: RunRecoveryRow[]): void {
  for (const row of rows) {
    if (!row.listDue) continue;
    const coordinator = all.find((other) => other.sessionId === row.coordinatorSessionId);
    if (coordinator?.status === 'pending') {
      row.status = 'pending';
      row.reason = 'timed-out';
      continue;
    }
    if (coordinator === undefined || coordinator.status === 'failed') {
      row.status = 'no-coordinator';
      row.reason = 'coordinator-missing';
    } else {
      row.status = 'left-to-coordinator';
      row.reason = null;
    }
    delete row.listDue;
  }
}

// A restarted agent that was not in the run and was `working` or `waiting`: nothing will continue it, and the report says so.
function markNotInRun(rows: RecoveryRow[], inRun: Set<string>): void {
  for (const row of rows) if (row.status === 'restarted' && !inRun.has(row.sessionId) && row.state !== 'done') row.reason = 'not-in-run';
}

/** Stores, on each recorded coordinator of the run that is not `failed` and not this session, its missing workers; clears every other list. */
function storeMissingWorkers(run: Run, members: Member[], all: RunRecoveryRow[], selfSessionId: string | null): void {
  for (const agent of run.agents) delete agent.missingWorkers;
  for (const { record, sessionId } of members) {
    const own = all.find((row) => row.sessionId === sessionId);
    if (record.role !== 'coordinator' || sessionId === selfSessionId || own === undefined || own.status === 'failed') continue;
    const workers: MissingWorker[] = all
      .filter((row) => row.role === 'worker' && row.coordinatorSessionId === sessionId && (row.status === 'left-to-coordinator' || (row.status === 'pending' && row.listDue)))
      .map((row) => ({ sessionId: row.sessionId as string, repo: row.repo, worktree: row.worktree, ...(row.dispatchId === undefined ? {} : { dispatchId: row.dispatchId }) }));
    if (workers.length > 0) record.missingWorkers = workers;
  }
}

/** The mode of a `recover` with an open pause run: no prompt, no recovery record, and the outcome is written to the run. */
export function pauseMode(state: PauseState): Mode {
  const { store, run, rows, withoutSessionId } = state;
  const merged = (): RunRecoveryRow[] => [...state.untouched, ...rows, ...withoutSessionId];
  // The start list comes from the rows, so a start and its row reach the disk in one write.
  const write = async (): Promise<void> => {
    run.recovery = {
      snapshotKey: state.snapshotKey,
      liveRuntime: state.liveRuntime,
      starts: [...state.carriedStarts, ...rows.filter((row) => row.startedAt !== undefined).map((row) => ({ sessionId: row.sessionId, startedAt: row.startedAt as string }))],
      rows: merged(),
    };
    await store.save(run);
  };
  return {
    // No prompt is sent in this mode, so no ack line is ever built from the token.
    token: '',
    begin: write,
    save: write,
    async finish() {
      // The rows are the same objects in every call, so the decisions below show in this list.
      const all = merged();
      decideWorkers(rows, all);
      markNotInRun(rows, new Set(state.members.map((member) => member.sessionId)));
      storeMissingWorkers(run, state.members, all, state.selfSessionId);
      await write();
    },
    onError: write,
    table: () => inTableOrder([...rows, ...withoutSessionId], (row) => row).map(recoveryRowOf),
  };
}
