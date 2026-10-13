import { Interrupted, throwIfAborted } from './abort.js';
import { isFiltered, matches } from './filters.js';
import { assertCurrentFormat, failure, listSnapshot, liveSources, nothingToDo, resolveFilterSet, withWarnings, type LiveSources } from './shared.js';
import { abandonPending, type RecordStore } from './store.js';
import type { BroadcastRecord, BroadcastTarget, Clock, FilterSpec, GroupFilter, OrcaPort, RunSummary } from './types.js';

// Present only when a filter is given: a plain close never uses the port. The filters narrow the pause run or the broadcast that is open.
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

// The live listings, or null when Orca does not answer: a close sends nothing, so the saved identity is enough.
async function liveSourcesIfAnswered({ port, clock }: CloseFilters, signal?: AbortSignal): Promise<LiveSources | null> {
  try {
    return await liveSources(await listSnapshot({ port, clock, signal }), { port, clock, signal });
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return null;
  }
}
