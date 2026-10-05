import { throwIfAborted } from './abort.js';
import { failure } from './shared.js';
import type { RecordStore } from './store.js';
import type { RunSummary } from './types.js';

export async function close(store: RecordStore, signal?: AbortSignal): Promise<RunSummary> {
  let run;
  try {
    throwIfAborted(signal);
    run = (await store.findOpenRun())?.run;
    throwIfAborted(signal);
  } catch (error) {
    return failure(error, null);
  }
  if (!run) return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [] };

  const abandoned = run.agents.filter((a) => a.resumeStatus === 'pending');
  for (const agent of abandoned) agent.resumeStatus = 'abandoned';
  run.status = 'closed';
  try {
    await store.save(run);
    await store.clearCurrent();
  } catch (error) {
    return failure(error, run);
  }
  return { outcome: 'done', exitCode: 0, run, error: null, rows: abandoned };
}
