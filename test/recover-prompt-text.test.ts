import { describe, expect, it } from 'vitest';
import { continueText, workerItems } from '../src/recover-prompt.js';

const BASE =
  '[orca-broadcast] Orca or the PC restarted, and your Claude Code session was restored. Your last turn did not finish, and a tool call that was running when it stopped did not run again. Check where you stopped, then continue your task.{WORKERS} If you are in the middle of a step, finish that step first. When you have handled this, end your reply with a short note on what you did. The last line of your reply must be exactly: ORCA-ACK abcd1234';

const WORKERS =
  ' These workers of yours did not come back: {ITEMS}. For each one, decide whether to retry it with orca-ide orchestration worker-start --task <its task id> --retry-of <dispatch id>, repeating its worktree and agent choices (--retry-of does not inherit them).';

describe('continueText', () => {
  it('is the exact text of the general spec for an agent that is not a coordinator with missing workers', () => {
    expect(continueText('abcd1234', [])).toBe(BASE.replace('{WORKERS}', ''));
  });

  it('adds the worker sentence, with its leading space and the literal angle-bracket text, for a coordinator', () => {
    const items = ['repo/tree-a (dispatch d-1)', 'repo/tree-b (dispatch unknown)'];
    expect(continueText('abcd1234', items)).toBe(BASE.replace('{WORKERS}', WORKERS.replace('{ITEMS}', items.join('; '))));
  });
});

describe('workerItems', () => {
  const worker = (repo: string, worktree: string, dispatchId?: string) => ({ repo, worktree, ...(dispatchId === undefined ? {} : { dispatchId }) });

  it('lists the rows in the order given, then the workers without a row by repo, worktree and dispatch ID (a missing dispatch ID last)', () => {
    const rows = [worker('z', 'z1', 'dz'), worker('a', 'a1')];
    const extra = [worker('b', 'w2', 'd2'), worker('b', 'w1'), worker('b', 'w1', 'd9'), worker('a', 'w9', 'd1'), worker('b', 'w1', 'd3')];
    expect(workerItems(rows, extra)).toEqual([
      'z/z1 (dispatch dz)',
      'a/a1 (dispatch unknown)',
      'a/w9 (dispatch d1)',
      'b/w1 (dispatch d3)',
      'b/w1 (dispatch d9)',
      'b/w1 (dispatch unknown)',
      'b/w2 (dispatch d2)',
    ]);
  });

  it('shows a null dispatch ID as unknown', () => {
    expect(workerItems([{ repo: 'r', worktree: 'w', dispatchId: null }], [])).toEqual(['r/w (dispatch unknown)']);
  });
});
