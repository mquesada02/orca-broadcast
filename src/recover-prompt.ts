import { compare } from './recover-classify.js';
import { ackLine } from './shared.js';

// A worker as the prompt and the self line show it.
interface WorkerLike {
  repo: string;
  worktree: string;
  dispatchId?: string | null;
}

/** `<repo>/<worktree> (dispatch <dispatch id>)`, or `(dispatch unknown)` when there is none. */
export const workerItem = ({ repo, worktree, dispatchId }: WorkerLike): string => `${repo}/${worktree} (dispatch ${dispatchId ?? 'unknown'})`;

/**
 * The items of a coordinator's worker list: the missing workers that have a row, in table order (as given), then the workers
 * without a row, ordered by repo, worktree and dispatch ID (a missing dispatch ID last).
 */
export function workerItems(rows: WorkerLike[], extra: WorkerLike[]): string[] {
  const sorted = [...extra].sort(
    (a, b) =>
      compare(a.repo, b.repo) ||
      compare(a.worktree, b.worktree) ||
      (a.dispatchId == null ? (b.dispatchId == null ? 0 : 1) : b.dispatchId == null ? -1 : compare(a.dispatchId, b.dispatchId)),
  );
  return [...rows, ...sorted].map(workerItem);
}

/** The continue prompt of `recover`, on one line. `items` is empty for an agent that is not a coordinator with missing workers. */
export function continueText(token: string, items: string[]): string {
  const workers =
    items.length === 0
      ? ''
      : ` These workers of yours did not come back: ${items.join('; ')}. For each one, decide whether to retry it with orca-ide orchestration worker-start --task <its task id> --retry-of <dispatch id>, repeating its worktree and agent choices (--retry-of does not inherit them).`;
  return `[orca-broadcast] Orca or the PC restarted, and your Claude Code session was restored. Your last turn did not finish, and a tool call that was running when it stopped did not run again. Check where you stopped, then continue your task.${workers} If you are in the middle of a step, finish that step first. When you have handled this, end your reply with a short note on what you did. The last line of your reply must be exactly: ${ackLine(token)}`;
}
