import { sleepOrAbort, throwIfAborted } from './abort.js';
import { cancelled, failure, iso, listAgentsFresh, listCoordinators, listFresh, locate, POLL_INTERVAL_MS, roleFirst, roleOf } from './shared.js';
import type { RecordStore } from './store.js';
import type { AgentRecord, AgentRow, Clock, Confirm, ConfirmTarget, ContinueBaseline, OrcaPort, ResumeProgress, ResumeReason, Run, RunSummary, TerminalRow } from './types.js';

const PROOF_WINDOW_MS = 60_000;

export interface ResumeDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
  onProgress?: (progress: ResumeProgress) => void;
  confirm?: Confirm;
  signal?: AbortSignal;
}

interface Awaiting {
  agent: AgentRecord;
  sentAt: number;
}

export const CONTINUE_MESSAGE =
  '[orca-pause] CONTINUE. The network is back. Continue your task from the note in your last pause reply.';

function movedSince(row: AgentRow, baseline: ContinueBaseline): boolean {
  return row.stateStartedAt !== baseline.stateStartedAt || row.lastAssistantMessage !== baseline.lastAssistantMessage;
}

const isProven = (agent: AgentRecord, row: AgentRow): boolean => Boolean(agent.continueSentAt && agent.continueBaseline && movedSince(row, agent.continueBaseline));
const isSendable = (row: AgentRow): boolean => row.state === 'working' || row.state === 'done';

// The agents sendAll would message, workers first.
function sendTargets(run: Run, rows: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, coordinators: Set<string>): ConfirmTarget[] {
  const targets: ConfirmTarget[] = [];
  for (const agent of run.agents.filter((a) => a.resumeStatus === 'pending')) {
    const located = locate(agent.paneKey, rows, terminals);
    if ('gone' in located || isProven(agent, located.row) || !isSendable(located.row)) continue;
    targets.push({ repo: agent.repo, worktree: agent.worktree, role: roleOf(located.handle, coordinators) });
  }
  return roleFirst(targets, 'worker', (target) => target.role);
}

export async function resume(deps: ResumeDeps): Promise<RunSummary> {
  const { port, clock, store } = deps;

  let run: Run | null;
  try {
    throwIfAborted(deps.signal);
    run = (await store.findOpenRun())?.run ?? null;
  } catch (error) {
    return failure(error, null);
  }
  if (!run) return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [] };

  let rows: Map<string, AgentRow>;
  let terminals: Map<string, TerminalRow>;
  let coordinators: Set<string>;
  try {
    [rows, terminals] = await listFresh(deps);
    coordinators = await listCoordinators(deps);
    const targets = deps.confirm ? sendTargets(run, rows, terminals, coordinators) : [];
    if (deps.confirm && targets.length > 0) {
      if (!(await deps.confirm(targets, deps.signal))) return cancelled();
      throwIfAborted(deps.signal);
      [rows, terminals] = await listFresh(deps); // the answer may have taken minutes
    }
  } catch (error) {
    return failure(error, run);
  }

  try {
    const awaiting = await sendAll(run, rows, terminals, coordinators, deps);
    reportProgress(run, deps);
    await awaitProof(run, awaiting, deps);
  } catch (error) {
    await store.save(run);
    return failure(error, run);
  }

  const finished = run.agents.every((a) => a.resumeStatus !== 'pending');
  if (finished) run.status = 'closed';
  await store.save(run);
  if (finished) await store.clearCurrent();
  return { outcome: 'done', exitCode: finished ? 0 : 1, run, error: null, rows: run.agents };
}

async function sendAll(run: Run, rows: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, coordinators: Set<string>, deps: ResumeDeps): Promise<Awaiting[]> {
  const awaiting: Awaiting[] = [];
  // The records change only inside the send loop, so a signal leaves the agents it never reached untouched.
  const pending = run.agents
    .filter((a) => a.resumeStatus === 'pending')
    .map((agent) => {
      const located = locate(agent.paneKey, rows, terminals);
      return { agent, located, role: 'gone' in located ? agent.role : roleOf(located.handle, coordinators) };
    });

  // Workers first, then coordinators: a send order only.
  for (const { agent, located, role } of roleFirst(pending, 'worker', (p) => p.role)) {
    throwIfAborted(deps.signal);
    delete agent.resumeReason;
    if ('gone' in located) {
      agent.resumeStatus = 'gone';
      agent.resumeReason = located.gone;
      continue;
    }
    agent.role = role;
    const { row, handle } = located;
    if (isProven(agent, row)) {
      agent.resumeStatus = 'resumed';
      continue;
    }
    if (!isSendable(row)) {
      agent.resumeReason = 'waiting-permission';
      continue;
    }

    agent.continueBaseline = { stateStartedAt: row.stateStartedAt, lastAssistantMessage: row.lastAssistantMessage };
    delete agent.continueSentAt;
    await deps.store.save(run);
    const result = await deps.port.send(handle, CONTINUE_MESSAGE).catch(() => ({ accepted: false as const }));
    if (!result.accepted) {
      agent.resumeReason = 'send-failed';
      continue;
    }
    const sentAt = deps.clock.now();
    agent.continueSentAt = iso(sentAt);
    if (row.state === 'working') {
      agent.resumeStatus = 'resumed';
      agent.resumeReason = 'queued-while-working';
    } else {
      awaiting.push({ agent, sentAt });
    }
  }
  return awaiting;
}

async function awaitProof(run: Run, awaiting: Awaiting[], deps: ResumeDeps): Promise<void> {
  const lastSend = Math.max(...awaiting.map((a) => a.sentAt));
  let open = awaiting;
  while (open.length > 0) {
    await sleepOrAbort(deps.clock, POLL_INTERVAL_MS, deps.signal);
    const rows = await listAgentsFresh(deps);
    const now = deps.clock.now();
    open = open.filter(({ agent, sentAt }) => {
      const row = rows.get(agent.paneKey);
      const proven = now - sentAt <= PROOF_WINDOW_MS && row && agent.continueBaseline && movedSince(row, agent.continueBaseline);
      if (proven) {
        agent.resumeStatus = 'resumed';
        delete agent.resumeReason;
      }
      return !proven;
    });
    await deps.store.save(run);
    reportProgress(run, deps);
    if (now - lastSend >= PROOF_WINDOW_MS) break;
  }
  for (const { agent } of open) agent.resumeReason = 'no-proof';
}

function reportProgress(run: Run, deps: ResumeDeps): void {
  const live = run.agents.filter((a) => a.resumeStatus !== 'gone');
  deps.onProgress?.({ resumed: live.filter((a) => a.resumeStatus === 'resumed').length, total: live.length });
}
