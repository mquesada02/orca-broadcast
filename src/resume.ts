import { failure, iso, listFresh, newestByPane, POLL_INTERVAL_MS } from './shared.js';
import type { RecordStore } from './store.js';
import type { AgentRecord, AgentRow, Clock, ContinueBaseline, OrcaPort, ResumeProgress, ResumeReason, Run, RunSummary, TerminalRow } from './types.js';

const PROOF_WINDOW_MS = 60_000;

export interface ResumeDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
  onProgress?: (progress: ResumeProgress) => void;
}

interface Awaiting {
  agent: AgentRecord;
  sentAt: number;
}

export const CONTINUE_MESSAGE =
  '[orca-pause] CONTINUE. The network is back. Continue your task from the note in your last pause reply.';

type Located = { gone: ResumeReason } | { row: AgentRow; handle: string };

function locate(agent: AgentRecord, rows: Map<string, AgentRow>, terminals: Map<string, TerminalRow>): Located {
  const terminal = terminals.get(agent.paneKey);
  if (!terminal) return { gone: 'terminal-closed' };
  if (terminal.orphaned) return { gone: 'terminal-orphaned' };
  const row = rows.get(agent.paneKey);
  if (!row) return { gone: 'agent-missing' };
  if (terminal.agentIdentity !== 'claude') return { gone: 'agent-exited' };
  return { row, handle: terminal.handle };
}

function movedSince(row: AgentRow, baseline: ContinueBaseline): boolean {
  return row.stateStartedAt !== baseline.stateStartedAt || row.lastAssistantMessage !== baseline.lastAssistantMessage;
}

export async function resume(deps: ResumeDeps): Promise<RunSummary> {
  const { port, clock, store } = deps;

  let run: Run | null;
  try {
    run = await store.findOpenRun();
  } catch (error) {
    return failure(error, null);
  }
  if (!run) return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [] };

  let rows: Map<string, AgentRow>;
  let terminals: Map<string, TerminalRow>;
  try {
    [rows, terminals] = await listFresh(port);
  } catch (error) {
    return failure(error, run);
  }

  try {
    const awaiting = await sendAll(run, rows, terminals, deps);
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

async function sendAll(run: Run, rows: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, deps: ResumeDeps): Promise<Awaiting[]> {
  const awaiting: Awaiting[] = [];
  for (const agent of run.agents.filter((a) => a.resumeStatus === 'pending')) {
    delete agent.resumeReason;
    const located = locate(agent, rows, terminals);
    if ('gone' in located) {
      agent.resumeStatus = 'gone';
      agent.resumeReason = located.gone;
      continue;
    }
    const { row, handle } = located;
    if (agent.continueSentAt && agent.continueBaseline && movedSince(row, agent.continueBaseline)) {
      agent.resumeStatus = 'resumed';
      continue;
    }
    if (row.state !== 'working' && row.state !== 'done') {
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
    await deps.clock.sleep(POLL_INTERVAL_MS);
    const rows = newestByPane(await deps.port.listAgents());
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
