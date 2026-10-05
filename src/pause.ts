import { randomBytes } from 'node:crypto';
import { sleepOrAbort, throwIfAborted } from './abort.js';
import type { RecordStore } from './store.js';
import { failure, iso, listCoordinators, listFresh, locate, POLL_INTERVAL_MS, roleFirst, roleOf } from './shared.js';
import type { AgentRecord, AgentRow, Clock, OrcaPort, PauseReason, Progress, Role, Run, RunSummary, TerminalRow } from './types.js';

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface PauseDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
  newToken?: () => string;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
}

const COORDINATOR_SENTENCE = 'Do not dispatch new workers or tasks.';

export function pauseMessage(token: string, role: Role = 'worker'): string {
  const message =
    '[orca-pause] The user is leaving and the network will drop. Finish the step you are on now. ' +
    'Do not start a new step and do not commit. Then end your turn with a short note: where you stopped, ' +
    `and your next step. The last line of your reply must be exactly: ORCA-PAUSED ${token}. ` +
    'After that, do nothing until you get a message that starts with [orca-pause] CONTINUE.';
  return role === 'coordinator' ? `${message} ${COORDINATOR_SENTENCE}` : message;
}

function randomToken(): string {
  return randomBytes(4).toString('hex');
}

function lastLine(message: string | null): string | null {
  const last = message?.trimEnd().split(/\r?\n/).at(-1)?.trim();
  if (!last) return null;
  return last.length >= 2 && last.startsWith('`') && last.endsWith('`') ? last.slice(1, -1) : last;
}

function provesPause(agent: AgentRecord, row: AgentRow, token: string): boolean {
  return (
    !agent.messagePending &&
    row.state === 'done' &&
    row.lastAssistantMessage !== agent.pauseBaseline &&
    lastLine(row.lastAssistantMessage) === `ORCA-PAUSED ${token}`
  );
}

function isGone(agent: AgentRecord): boolean {
  return agent.resumeStatus === 'gone';
}

function isSettled(agent: AgentRecord): boolean {
  return isGone(agent) || agent.pauseStatus === 'confirmed' || agent.pauseReason === 'send-failed';
}

// Any state other than working or done (waiting, or one we do not know) is treated like a permission prompt.
function isWaitingLike(state: string): boolean {
  return state !== 'working' && state !== 'done';
}

function reopen(agent: AgentRecord, row: AgentRow): void {
  agent.pauseStatus = 'unconfirmed';
  agent.pauseBaseline = row.lastAssistantMessage;
  agent.confirmedAt = null;
}

function requestPause(agent: AgentRecord, row: AgentRow): void {
  reopen(agent, row);
  agent.pauseReason = isWaitingLike(row.state) ? 'waiting-permission' : 'still-working';
  agent.messagePending = true;
}

function isSweepable(row: AgentRow): boolean {
  return row.agentType === 'claude' && row.state === 'working';
}

function newAgent(row: AgentRow): AgentRecord {
  const agent: AgentRecord = {
    paneKey: row.paneKey,
    worktreeId: row.worktreeId,
    worktree: row.worktree,
    repo: row.repo,
    role: 'worker',
    lastHandle: null,
    pauseStatus: 'unconfirmed',
    pauseReason: null,
    pauseBaseline: null,
    messagePending: false,
    confirmedAt: null,
    wakeCount: 0,
    resumeStatus: 'pending',
  };
  requestPause(agent, row);
  return agent;
}

// send-failed is always kept, or the agent would be retried; re-woken is kept until it confirms.
function recheckReason(agent: AgentRecord, row: AgentRow): PauseReason {
  if (agent.pauseReason === 'send-failed') return 'send-failed';
  if (!agent.messagePending && agent.pauseReason === 're-woken') return 're-woken';
  if (isWaitingLike(row.state)) return 'waiting-permission';
  if (agent.messagePending) return 'still-working';
  return row.state === 'working' ? 'still-working' : 'done-no-token';
}

export async function pause(timeoutMs: number, deps: PauseDeps): Promise<RunSummary> {
  const { clock, store } = deps;

  let agents: Map<string, AgentRow>;
  let terminals: Map<string, TerminalRow>;
  try {
    throwIfAborted(deps.signal);
    const open = await store.findOpenRun();
    if (open) {
      const others = open.others.map((r) => r.runId);
      throw new Error(
        `an open pause run already exists: ${open.run.runId} in ${store.dir}` +
          (others.length > 0 ? ` (other open runs: ${others.join(', ')})` : '') +
          '; extending it is not supported yet, so run orca-pause close to abandon it before pausing again',
      );
    }
    [agents, terminals] = await listFresh(deps);
    throwIfAborted(deps.signal);
  } catch (error) {
    return failure(error, null);
  }

  const discovered = [...agents.values()].filter(isSweepable);
  if (discovered.length === 0) {
    return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [] };
  }

  const startedAt = clock.now();
  const token = (deps.newToken ?? randomToken)();
  const run: Run = {
    runId: `${iso(startedAt).replace(/[-:.]/g, '')}-${token}`,
    token,
    startedAt: iso(startedAt),
    status: 'open',
    agents: discovered.map(newAgent),
  };
  await store.save(run);
  await store.setCurrent(run.runId);

  try {
    while (true) {
      throwIfAborted(deps.signal);
      const coordinators = await listCoordinators(deps);
      await poll(run, agents, terminals, coordinators, deps);
      await store.save(run);
      reportProgress(run, startedAt + timeoutMs - clock.now(), deps);
      throwIfAborted(deps.signal);
      if (run.agents.every(isSettled)) break;
      await sleepOrAbort(clock, POLL_INTERVAL_MS, deps.signal);
      if (clock.now() - startedAt >= timeoutMs) break;
      [agents, terminals] = await listFresh(deps);
    }
  } catch (error) {
    await store.save(run);
    return failure(error, run);
  }

  const unconfirmed = run.agents.some((a) => a.pauseStatus === 'unconfirmed');
  return { outcome: 'done', exitCode: unconfirmed ? 1 : 0, run, error: null, rows: run.agents };
}

// Gone is permanent within a run: a gone agent is never located again, even if its terminal reappears.
// Its pauseStatus and pauseReason are frozen, so the exit code still reports it when it was never confirmed.
function markLocated(agent: AgentRecord, agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>): { row: AgentRow; handle: string } | null {
  const found = locate(agent.paneKey, agents, terminals);
  if ('gone' in found) {
    agent.resumeStatus = 'gone';
    agent.resumeReason = found.gone;
    return null;
  }
  agent.lastHandle = found.handle;
  return found;
}

async function poll(run: Run, agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, coordinators: Set<string>, deps: PauseDeps): Promise<void> {
  for (const row of agents.values()) {
    if (!isSweepable(row) || run.agents.some((a) => a.paneKey === row.paneKey)) continue;
    run.agents.push(newAgent(row));
  }

  const live: { agent: AgentRecord; row: AgentRow }[] = [];
  for (const agent of run.agents.filter((a) => !isGone(a))) {
    const located = markLocated(agent, agents, terminals);
    if (located) {
      agent.role = roleOf(located.handle, coordinators);
      live.push({ agent, row: located.row });
    }
  }

  for (const { agent, row } of live.filter(({ agent }) => agent.pauseStatus === 'confirmed')) {
    if (row.state === 'done' && row.lastAssistantMessage === agent.pauseBaseline) continue;
    agent.wakeCount += 1;
    if (agent.wakeCount === 1) {
      requestPause(agent, row);
    } else {
      reopen(agent, row);
      agent.pauseReason = 're-woken';
    }
  }

  for (const { agent, row } of live.filter(({ agent }) => agent.pauseStatus === 'unconfirmed')) {
    if (provesPause(agent, row, run.token)) {
      agent.pauseStatus = 'confirmed';
      agent.pauseBaseline = row.lastAssistantMessage;
      agent.confirmedAt = iso(deps.clock.now());
      agent.pauseReason = null;
    } else {
      agent.pauseReason = recheckReason(agent, row);
    }
  }

  for (const { agent, row } of roleFirst(live, 'coordinator', ({ agent }) => agent.role)) {
    if (!agent.messagePending || agent.pauseReason === 'send-failed' || isWaitingLike(row.state)) continue;
    throwIfAborted(deps.signal);
    await deps.store.save(run);
    const [freshAgents, freshTerminals] = await listFresh(deps);
    const fresh = markLocated(agent, freshAgents, freshTerminals);
    if (!fresh) continue;
    if (isWaitingLike(fresh.row.state)) {
      agent.pauseReason = 'waiting-permission';
      continue;
    }
    const result = await deps.port.send(fresh.handle, pauseMessage(run.token, agent.role));
    if (result.accepted) {
      agent.pauseBaseline = fresh.row.lastAssistantMessage;
      agent.messagePending = false;
    } else {
      agent.pauseReason = 'send-failed';
    }
  }
}

function reportProgress(run: Run, remainingMs: number, deps: PauseDeps): void {
  if (!deps.onProgress) return;
  const reasons: Progress['reasons'] = {};
  const live = run.agents.filter((a) => !isGone(a));
  for (const agent of live) {
    if (agent.pauseReason) reasons[agent.pauseReason] = (reasons[agent.pauseReason] ?? 0) + 1;
  }
  deps.onProgress({
    confirmed: live.filter((a) => a.pauseStatus === 'confirmed').length,
    total: live.length,
    reasons,
    remainingMs: Math.max(0, remainingMs),
  });
}
