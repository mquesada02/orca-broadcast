import { randomBytes } from 'node:crypto';
import { sleepOrAbort, throwIfAborted } from './abort.js';
import type { RecordStore } from './store.js';
import { cancelled, failure, iso, listCoordinators, listFresh, locate, POLL_INTERVAL_MS, roleFirst, roleOf } from './shared.js';
import type { AgentRecord, AgentRow, Clock, Confirm, ConfirmTarget, OrcaPort, PauseReason, Progress, Role, Run, RunSummary, TerminalRow } from './types.js';

type Found = { row: AgentRow; handle: string };

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface PauseDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
  newToken?: () => string;
  selfPaneKey?: string;
  onProgress?: (progress: Progress) => void;
  confirm?: Confirm;
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

function clearContinueProof(agent: AgentRecord): void {
  delete agent.continueBaseline;
  delete agent.continueSentAt;
}

function reopen(agent: AgentRecord, row: AgentRow): void {
  agent.pauseStatus = 'unconfirmed';
  agent.pauseBaseline = row.lastAssistantMessage;
  agent.confirmedAt = null;
  clearContinueProof(agent);
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

// Self is never paused by this command: it is recorded as pending for resume, whatever its earlier record was.
function markSelf(existing: AgentRecord | undefined, row: AgentRow, handle: string): AgentRecord {
  const agent = existing ?? newAgent(row);
  reopen(agent, row);
  Object.assign(agent, {
    worktree: row.worktree,
    repo: row.repo,
    lastHandle: handle,
    pauseReason: 'self',
    messagePending: false,
    wakeCount: 0,
    resumeStatus: 'pending',
  });
  delete agent.resumeReason;
  return agent;
}

// The summary keeps self apart from the rows; self is null unless this invocation still has it as a live self row.
function withSelf(summary: RunSummary, selfPaneKey: string | undefined): RunSummary {
  const self = summary.run?.agents.find((a) => a.paneKey === selfPaneKey && a.pauseReason === 'self' && !isGone(a)) ?? null;
  return { ...summary, rows: summary.rows.filter((a) => a !== self), self };
}

// send-failed is always kept, or the agent would be retried; re-woken is kept until it confirms.
function recheckReason(agent: AgentRecord, row: AgentRow): PauseReason {
  if (agent.pauseReason === 'send-failed') return 'send-failed';
  if (!agent.messagePending && agent.pauseReason === 're-woken') return 're-woken';
  if (isWaitingLike(row.state)) return 'waiting-permission';
  if (agent.messagePending) return 'still-working';
  return row.state === 'working' ? 'still-working' : 'done-no-token';
}

type Prepared = { run: Run; extending: boolean } | { summary: RunSummary };

// Builds the run this invocation works on, in memory: the loaded run extended, or a new run of the agents found working.
// The loaded run is never changed, so it stays available as the pre-invocation record.
function prepare(loaded: Run | null, startedAt: number, newToken: () => string, agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, selfKey: string | undefined): Prepared {
  const selfFound = selfKey ? locate(selfKey, agents, terminals) : null;
  const self = selfFound && !('gone' in selfFound) && selfFound.row.agentType === 'claude' ? selfFound : null;

  if (loaded) {
    const run = structuredClone(loaded);
    handOverSelf(run, selfKey, self, agents, terminals);
    extend(run, selfKey, agents, terminals);
    return { run, extending: true };
  }
  const discovered = [...agents.values()].filter((row) => isSweepable(row) && row.paneKey !== selfKey);
  if (discovered.length === 0) {
    const onlySelf = self?.row.state === 'working' ? markSelf(undefined, self.row, self.handle) : null;
    return { summary: { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [], self: onlySelf } };
  }
  const token = newToken();
  const run: Run = {
    runId: `${iso(startedAt).replace(/[-:.]/g, '')}-${token}`,
    token,
    startedAt: iso(startedAt),
    status: 'open',
    agents: discovered.map(newAgent),
  };
  if (self) run.agents.push(markSelf(undefined, self.row, self.handle));
  return { run, extending: false };
}

export async function pause(timeoutMs: number, deps: PauseDeps): Promise<RunSummary> {
  const { clock, store } = deps;
  const selfKey = deps.selfPaneKey || undefined; // an empty ORCA_PANE_KEY means there is no self
  let startedAt = clock.now();
  let token: string | undefined;
  const newToken = () => (token ??= (deps.newToken ?? randomToken)());

  let loaded: Run | null;
  let agents: Map<string, AgentRow>;
  let terminals: Map<string, TerminalRow>;
  let prepared: Prepared;
  let confirmed = false;
  try {
    throwIfAborted(deps.signal);
    loaded = (await store.findOpenRun())?.run ?? null;
    [agents, terminals] = await listFresh(deps);
    throwIfAborted(deps.signal);
    prepared = prepare(loaded, startedAt, newToken, agents, terminals, selfKey);
    if (deps.confirm && 'run' in prepared) {
      const targets = planSends(prepared.run, agents, terminals, await listCoordinators(deps), deps, selfKey);
      if (targets.length > 0) {
        if (!(await deps.confirm(targets, deps.signal))) return withSelf(cancelled(), selfKey);
        throwIfAborted(deps.signal);
        confirmed = true;
        // The answer may have taken minutes: look again and start the clock now.
        [agents, terminals] = await listFresh(deps);
        startedAt = clock.now();
        prepared = prepare(loaded, startedAt, newToken, agents, terminals, selfKey);
      }
    }
  } catch (error) {
    return withSelf(failure(error, null), selfKey);
  }
  if ('summary' in prepared) return prepared.summary;

  const { run, extending } = prepared;
  await store.save(run);
  if (!extending) await store.setCurrent(run.runId); // findOpenRun already points at an open run

  // Before the first send pass that was not confirmed at the start: a "no" or a failure leaves the records as they were before this invocation.
  const confirmLate = async (coordinators: Set<string>): Promise<RunSummary | null> => {
    try {
      const targets = planSends(run, agents, terminals, coordinators, deps, selfKey);
      if (targets.length === 0) return null;
      const yes = await deps.confirm!(targets, deps.signal);
      throwIfAborted(deps.signal);
      if (yes) {
        confirmed = true;
        [agents, terminals] = await listFresh(deps);
        startedAt = clock.now();
        return null;
      }
      if (loaded) await store.save(loaded);
      return withSelf(cancelled(), selfKey);
    } catch (error) {
      if (loaded) await store.save(loaded);
      return withSelf(failure(error, null), selfKey);
    }
  };

  try {
    while (true) {
      throwIfAborted(deps.signal);
      const coordinators = await listCoordinators(deps);
      if (deps.confirm && !confirmed) {
        const declined = await confirmLate(coordinators);
        if (declined) return declined;
      }
      await poll(run, agents, terminals, coordinators, deps, selfKey);
      await store.save(run);
      reportProgress(run, startedAt + timeoutMs - clock.now(), deps, selfKey);
      throwIfAborted(deps.signal);
      if (run.agents.every((a) => a.paneKey === selfKey || isSettled(a))) break;
      await sleepOrAbort(clock, POLL_INTERVAL_MS, deps.signal);
      if (clock.now() - startedAt >= timeoutMs) break;
      [agents, terminals] = await listFresh(deps);
    }
  } catch (error) {
    await store.save(run);
    return withSelf(failure(error, run), selfKey);
  }

  const unconfirmed = run.agents.some((a) => a.paneKey !== selfKey && a.pauseStatus === 'unconfirmed');
  return withSelf({ outcome: 'done', exitCode: unconfirmed ? 1 : 0, run, error: null, rows: run.agents }, selfKey);
}

// Self handover: an earlier self that is not the current self becomes a normal agent; the current self is recorded for resume.
function handOverSelf(run: Run, selfKey: string | undefined, self: Found | null, agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>): void {
  for (const agent of run.agents) {
    if (agent.pauseReason !== 'self' || agent.paneKey === selfKey || isGone(agent)) continue;
    const found = locate(agent.paneKey, agents, terminals);
    if (!('gone' in found)) requestPause(agent, found.row);
  }
  if (!self) return;
  const existing = run.agents.find((a) => a.paneKey === self.row.paneKey);
  const recorded = markSelf(existing, self.row, self.handle);
  if (!existing) run.agents.push(recorded);
}

// Extending an open run: the start-of-invocation rules. Agents that cannot be located are left for the first poll.
function extend(run: Run, selfKey: string | undefined, agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>): void {
  for (const agent of run.agents) {
    if (isGone(agent) || agent.paneKey === selfKey) continue;
    agent.wakeCount = 0;
    const found = locate(agent.paneKey, agents, terminals);
    if ('gone' in found) continue;
    const resumed = agent.resumeStatus === 'resumed';
    if (resumed || agent.pauseReason === 'send-failed' || agent.pauseReason === 're-woken') requestPause(agent, found.row);
    if (resumed) {
      agent.resumeStatus = 'pending';
      delete agent.resumeReason;
    }
  }
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

// The in-memory part of a poll: sweep newcomers, locate, check wake-ups and proofs. It sends nothing and saves nothing.
function refresh(run: Run, agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, coordinators: Set<string>, deps: Pick<PauseDeps, 'clock'>, selfKey: string | undefined): { agent: AgentRecord; row: AgentRow }[] {
  for (const row of agents.values()) {
    if (!isSweepable(row) || row.paneKey === selfKey || run.agents.some((a) => a.paneKey === row.paneKey)) continue;
    run.agents.push(newAgent(row));
  }

  const live: { agent: AgentRecord; row: AgentRow }[] = [];
  for (const agent of run.agents.filter((a) => !isGone(a))) {
    const located = markLocated(agent, agents, terminals);
    if (located) {
      agent.role = roleOf(located.handle, coordinators);
      if (agent.paneKey !== selfKey) live.push({ agent, row: located.row });
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
  return live;
}

// The agents a poll would message, coordinators first.
function sendQueue(live: { agent: AgentRecord; row: AgentRow }[]): { agent: AgentRecord; row: AgentRow }[] {
  return roleFirst(live, 'coordinator', ({ agent }) => agent.role).filter(({ agent, row }) => wantsSend(agent, row));
}

function wantsSend(agent: AgentRecord, row: AgentRow): boolean {
  return agent.messagePending && agent.pauseReason !== 'send-failed' && !isWaitingLike(row.state);
}

// Who the next poll would message, found by running its in-memory part on a copy of the run.
function planSends(run: Run, agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, coordinators: Set<string>, deps: Pick<PauseDeps, 'clock'>, selfKey: string | undefined): ConfirmTarget[] {
  return sendQueue(refresh(structuredClone(run), agents, terminals, coordinators, deps, selfKey)).map(({ agent }) => ({ repo: agent.repo, worktree: agent.worktree, role: agent.role }));
}

async function poll(run: Run, agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, coordinators: Set<string>, deps: PauseDeps, selfKey: string | undefined): Promise<void> {
  const live = refresh(run, agents, terminals, coordinators, deps, selfKey);

  for (const { agent, row } of sendQueue(live)) {
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

function reportProgress(run: Run, remainingMs: number, deps: PauseDeps, selfKey: string | undefined): void {
  if (!deps.onProgress) return;
  const reasons: Progress['reasons'] = {};
  const live = run.agents.filter((a) => !isGone(a) && a.paneKey !== selfKey);
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
