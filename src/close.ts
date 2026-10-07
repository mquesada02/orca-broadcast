import { throwIfAborted } from './abort.js';
import { releaseBroadcast } from './broadcast.js';
import { failure } from './shared.js';
import type { RecordStore } from './store.js';
import type { BroadcastRecord, RunSummary } from './types.js';

// Temporary: until #70 builds the recovery that abandons a broadcast beside an open pause run, close leaves it open and says so.
const UNTOUCHED_BROADCAST_WARNING = (record: BroadcastRecord) => `broadcast ${record.id} is also open and was left untouched; run close again after this one`;

export async function close(store: RecordStore, signal?: AbortSignal): Promise<RunSummary> {
  let open;
  try {
    throwIfAborted(signal);
    open = await store.loadOpen();
    throwIfAborted(signal);
  } catch (error) {
    return failure(error, null);
  }
  const run = open.pause?.record;
  const broadcast = open.broadcast?.record;
  if (!run && broadcast) return closeBroadcast(store, broadcast);
  if (!run) return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [], record: null };

  const abandoned = run.agents.filter((a) => a.resumeStatus === 'pending');
  for (const agent of abandoned) agent.resumeStatus = 'abandoned';
  run.status = 'closed';
  try {
    await store.save(run);
    await store.clearCurrent('pause', run.runId);
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
