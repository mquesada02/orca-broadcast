import { Interrupted, throwIfAborted } from './abort.js';
import { hasFilters, matches } from './filters.js';
import { assertCurrentFormat, failure, listSnapshot, liveSources, nothingToDo, releaseBroadcast, resolveFilterSet, type LiveSources } from './shared.js';
import type { RecordStore } from './store.js';
import type { BroadcastRecord, Clock, FilterSpec, OrcaPort, RunSummary } from './types.js';

// Temporary: until #70 builds the recovery that abandons a broadcast beside an open pause run, close leaves it open and says so.
const UNTOUCHED_BROADCAST_WARNING = (record: BroadcastRecord) => `broadcast ${record.id} is also open and was left untouched; run close again after this one`;

// Present only when a filter is given: a plain close never uses the port.
export interface CloseFilters {
  filters: FilterSpec;
  port: OrcaPort;
  clock: Clock;
  cwd?: string;
}

export async function close(store: RecordStore, signal?: AbortSignal, filtered?: CloseFilters): Promise<RunSummary> {
  let open;
  let abandoned;
  try {
    throwIfAborted(signal);
    open = await store.loadOpen();
    throwIfAborted(signal);
  } catch (error) {
    return failure(error, null);
  }
  const run = open.pause?.record;
  const broadcast = open.broadcast?.record;
  // Filters on a broadcast record belong to #69: a filtered close with only a broadcast open has nothing to close.
  if (!run && broadcast && !filtered) return closeBroadcast(store, broadcast);
  if (!run) return { ...nothingToDo(), record: null };

  try {
    abandoned = run.agents.filter((a) => a.resumeStatus === 'pending');
    if (filtered && hasFilters(filtered.filters)) {
      assertCurrentFormat(run);
      // The values resolve against the saved record, and against the live listings when Orca answers.
      const { port, clock, cwd } = filtered;
      let live: LiveSources | null = null;
      try {
        live = await liveSources(await listSnapshot({ port, clock, signal }), { port, clock, signal });
      } catch (error) {
        if (error instanceof Interrupted) throw error;
      }
      const set = resolveFilterSet(filtered.filters, live, run.agents, cwd);
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
  return { outcome: 'done', exitCode: 0, run, error: null, rows: abandoned, record: null, ...(broadcast ? { warning: UNTOUCHED_BROADCAST_WARNING(broadcast) } : {}) };
}

async function closeBroadcast(store: RecordStore, record: BroadcastRecord): Promise<RunSummary> {
  for (const target of record.targets.filter((t) => t.status === 'pending')) {
    target.status = 'abandoned';
    target.reason = 'closed';
  }
  releaseBroadcast(record);
  try {
    await store.saveBroadcast(record);
    await store.clearCurrent('broadcast', record.id);
  } catch (error) {
    return { ...failure(error, null), record };
  }
  return { outcome: 'done', exitCode: 0, run: null, error: null, rows: [], record };
}
