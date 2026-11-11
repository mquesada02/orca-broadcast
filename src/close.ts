import { Interrupted, throwIfAborted } from './abort.js';
import { isFiltered, matches } from './filters.js';
import { assertCurrentFormat, failure, listSnapshot, liveSources, nothingToDo, resolveFilterSet, withWarnings, type LiveSources } from './shared.js';
import { abandonRecovery, isFinalRow, recoveryRowOf } from './recover-record.js';
import { abandonPending, type RecordStore } from './store.js';
import type { BroadcastRecord, BroadcastTarget, Clock, FilterSpec, GroupFilter, OrcaPort, RecoveryRecord, RecoveryRow, RecoverySummary, RunSummary } from './types.js';

const BROKEN_STATE_FILTER_MESSAGE = 'a recovery and a broadcast are both open; run `orca-broadcast close` without filters';

// Present only when a filter is given: a plain close never uses the port. The filters narrow the pause run, the broadcast or the recovery that is open.
export interface CloseFilters {
  filters: FilterSpec;
  groups?: GroupFilter[];
  port: OrcaPort;
  clock: Clock;
  cwd?: string;
}

export function close(store: RecordStore, signal?: AbortSignal, filtered?: CloseFilters): Promise<RunSummary> {
  return withWarnings((warnings) => runClose(store, warnings, signal, filtered));
}

async function runClose(store: RecordStore, warnings: string[], signal?: AbortSignal, filtered?: CloseFilters): Promise<RunSummary> {
  let open;
  let abandoned;
  try {
    throwIfAborted(signal);
    open = await store.loadOpen();
    warnings.push(...open.notes);
    throwIfAborted(signal);
  } catch (error) {
    return failure(error, null);
  }
  const run = open.pause?.record;
  const broadcast = open.broadcast?.record;
  const recovery = open.recovery?.record;
  if (!run && recovery && broadcast) return closeBoth(store, recovery, broadcast, filtered);
  if (!run && recovery) return closeRecovery(store, recovery, signal, filtered);
  if (!run && broadcast) return closeBroadcast(store, broadcast, signal, filtered);
  if (!run) return { ...nothingToDo(), record: null };

  try {
    abandoned = run.agents.filter((a) => a.resumeStatus === 'pending');
    if (filtered && isFiltered(filtered.filters, filtered.groups)) {
      assertCurrentFormat(run);
      // The values resolve against the saved record, and against the live listings when Orca answers.
      const set = resolveFilterSet(filtered.filters, await liveSourcesIfAnswered(filtered, signal), run.agents, filtered.cwd, filtered.groups);
      abandoned = abandoned.filter((a) => matches(set, a));
      if (abandoned.length === 0) return { ...nothingToDo(), record: null };
    }
  } catch (error) {
    return failure(error, null);
  }

  for (const agent of abandoned) agent.resumeStatus = 'abandoned';
  const finished = run.agents.every((a) => a.resumeStatus !== 'pending');
  if (finished) run.status = 'closed';
  try {
    await store.save(run);
    if (finished) await store.clearCurrent('pause', run.runId);
  } catch (error) {
    return failure(error, run);
  }
  return { outcome: 'done', exitCode: 0, run, error: null, rows: abandoned, record: null };
}

// A plain close abandons every pending target. With filters it abandons the matching ones, resolved against the live listings
// (when Orca answers) and the identity saved in the record; the record closes itself when nothing is pending.
async function closeBroadcast(store: RecordStore, record: BroadcastRecord, signal?: AbortSignal, filtered?: CloseFilters): Promise<RunSummary> {
  let select: (target: BroadcastTarget) => boolean = () => true;
  try {
    if (filtered && isFiltered(filtered.filters, filtered.groups)) {
      const live = await liveSourcesIfAnswered(filtered, signal);
      const set = resolveFilterSet(filtered.filters, live, record.targets, filtered.cwd, filtered.groups);
      select = (target) => matches(set, target);
      if (!record.targets.some((t) => t.status === 'pending' && select(t))) return { ...nothingToDo(), record: null };
    }
  } catch (error) {
    return failure(error, null);
  }
  const abandoned = abandonPending(record, 'closed', select);
  try {
    await store.saveBroadcast(record);
    if (record.status === 'closed') await store.clearCurrent('broadcast', record.id);
  } catch (error) {
    return { ...failure(error, null), record };
  }
  return { outcome: 'done', exitCode: 0, run: null, error: null, rows: [], record, abandoned };
}

const recoverySummaryOf = (record: RecoveryRecord): RecoverySummary => ({ rows: record.rows.map(recoveryRowOf), snapshots: [], self: null, record, cleared: [] });

// The same as a broadcast close, for the rows of a recovery: a plain close abandons every row that is not final, and with filters the
// matching ones. The record closes itself when every row is final afterwards.
async function closeRecovery(store: RecordStore, record: RecoveryRecord, signal?: AbortSignal, filtered?: CloseFilters): Promise<RunSummary> {
  let select: (row: RecoveryRow) => boolean = () => true;
  try {
    if (filtered && isFiltered(filtered.filters, filtered.groups)) {
      const live = await liveSourcesIfAnswered(filtered, signal);
      const set = resolveFilterSet(filtered.filters, live, record.rows, filtered.cwd, filtered.groups);
      select = (row) => matches(set, row);
      if (!record.rows.some((row) => !isFinalRow(row, record.rows) && select(row))) return { ...nothingToDo(), record: null };
    }
  } catch (error) {
    return failure(error, null);
  }
  abandonRecovery(record, 'closed', select);
  try {
    await store.saveRecovery(record);
    if (record.status === 'closed') await store.clearCurrent('recovery', record.id);
  } catch (error) {
    return { ...failure(error, null), record };
  }
  return { outcome: 'done', exitCode: 0, run: null, error: null, rows: [], record, recovery: recoverySummaryOf(record) };
}

// A recovery and a broadcast open together (the broken state): only a close without filters clears both.
async function closeBoth(store: RecordStore, recovery: RecoveryRecord, broadcast: BroadcastRecord, filtered?: CloseFilters): Promise<RunSummary> {
  if (filtered && isFiltered(filtered.filters, filtered.groups)) return failure(new Error(BROKEN_STATE_FILTER_MESSAGE), null);
  abandonRecovery(recovery, 'closed');
  abandonPending(broadcast, 'closed');
  try {
    await store.saveRecovery(recovery);
    await store.saveBroadcast(broadcast);
    await store.clearCurrent('recovery', recovery.id);
    await store.clearCurrent('broadcast', broadcast.id);
  } catch (error) {
    return { ...failure(error, null), record: recovery };
  }
  return { outcome: 'done', exitCode: 0, run: null, error: null, rows: [], record: recovery, recovery: recoverySummaryOf(recovery), closedBroadcast: broadcast.id };
}

// The live listings, or null when Orca does not answer: a close sends nothing, so the saved identity is enough.
async function liveSourcesIfAnswered({ port, clock }: CloseFilters, signal?: AbortSignal): Promise<LiveSources | null> {
  try {
    return await liveSources(await listSnapshot({ port, clock, signal }), { port, clock, signal });
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return null;
  }
}
