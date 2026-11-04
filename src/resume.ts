import { sleepOrAbort, throwIfAborted } from './abort.js';
import { continueSentence, type Preset } from './reasons.js';
import { isFiltered, matches, NO_FILTERS } from './filters.js';
import { autoRoster, type AutoRoster } from './roster-cmd.js';
import { assertCurrentFormat, cancelled, coordinatorsLast, failure, identityOf, iso, listAgentsFresh, listSnapshot, nothingToDo, locate, POLL_INTERVAL_MS, liveSources, resolveFilterSet, roleInfoOf, withWarnings, type Roles, type Snapshot } from './shared.js';
import type { RecordStore } from './store.js';
import type { AgentRecord, AgentRow, Clock, Confirm, ConfirmTarget, ContinueBaseline, FilterSpec, GroupFilter, OrcaPort, ResumeProgress, ResumeReason, Run, RunSummary, TerminalRow } from './types.js';

const PROOF_WINDOW_MS = 60_000;

export interface ResumeDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
  filters?: FilterSpec;
  groups?: GroupFilter[];
  cwd?: string;
  selfPaneKey?: string;
  onProgress?: (progress: ResumeProgress) => void;
  confirm?: Confirm;
  signal?: AbortSignal;
}

interface Awaiting {
  agent: AgentRecord;
  sentAt: number;
}

export const continueMessage = (reason?: Preset): string =>
  `[orca-broadcast] CONTINUE. ${continueSentence(reason)} Continue your task from the note in your last pause reply.`;

function movedSince(row: AgentRow, baseline: ContinueBaseline): boolean {
  return row.stateStartedAt !== baseline.stateStartedAt || row.lastAssistantMessage !== baseline.lastAssistantMessage;
}

const isProven = (agent: AgentRecord, row: AgentRow): boolean => Boolean(agent.continueSentAt && agent.continueBaseline && movedSince(row, agent.continueBaseline));
const isSendable = (row: AgentRow): boolean => row.state === 'working' || row.state === 'done';

// The agents sendAll would message, coordinators last.
function sendTargets(selected: AgentRecord[], rows: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, roles: Roles, selfKey: string | undefined): ConfirmTarget[] {
  const targets: ConfirmTarget[] = [];
  for (const agent of selected) {
    if (agent.paneKey === selfKey) continue;
    const located = locate(agent.paneKey, rows, terminals);
    if ('gone' in located || isProven(agent, located.row) || !isSendable(located.row)) continue;
    targets.push({ repo: agent.repo, worktree: agent.worktree, role: roleInfoOf(roles, agent.paneKey).role });
  }
  return coordinatorsLast(targets, (target) => target.role);
}

export function resume(deps: ResumeDeps): Promise<RunSummary> {
  return withWarnings((warnings) => runResume(deps, warnings));
}

async function runResume(deps: ResumeDeps, warnings: string[]): Promise<RunSummary> {
  const roster = autoRoster(deps, warnings);
  const seen: { newest: Snapshot | null } = { newest: null };
  const summary = await resumeSteps(deps, warnings, roster, seen);
  await roster.end(seen.newest);
  return summary;
}

// `seen.newest` is the newest snapshot this run took, for the end roster save.
async function resumeSteps(deps: ResumeDeps, warnings: string[], roster: AutoRoster, seen: { newest: Snapshot | null }): Promise<RunSummary> {
  const { port, clock, store } = deps;
  const selfKey = deps.selfPaneKey || undefined; // an empty ORCA_PANE_KEY means there is no self

  let run: Run | null;
  try {
    throwIfAborted(deps.signal);
    const open = await store.loadOpen();
    warnings.push(...open.notes);
    run = open.pause?.record ?? null;
    if (run) assertCurrentFormat(run);
  } catch (error) {
    return failure(error, null);
  }
  if (!run) return nothingToDo();

  let rows: Map<string, AgentRow>;
  let terminals: Map<string, TerminalRow>;
  let roles: Roles;
  // The agents this invocation acts on: the pending agents that match the filters, by the values saved in the record.
  let selected: AgentRecord[];
  try {
    const snapshot = await listSnapshot(deps);
    seen.newest = snapshot;
    ({ agents: rows, terminals, roles } = snapshot);
    await roster.start(snapshot);
    const filters = deps.filters ?? NO_FILTERS;
    const set = resolveFilterSet(filters, isFiltered(filters, deps.groups) ? await liveSources(snapshot, deps) : null, run.agents, deps.cwd, deps.groups);
    selected = run.agents.filter((a) => a.resumeStatus === 'pending' && matches(set, a));
    if (isFiltered(filters, deps.groups) && selected.length === 0) return nothingToDo();
    if (deps.confirm) {
      const targets = sendTargets(selected, rows, terminals, roles, selfKey);
      if (targets.length > 0) {
        if (!(await deps.confirm(targets, deps.signal))) return cancelled();
        throwIfAborted(deps.signal);
        seen.newest = await listSnapshot(deps); // the answer may have taken minutes
        ({ agents: rows, terminals, roles } = seen.newest);
      }
    }
  } catch (error) {
    return failure(error, run);
  }

  try {
    const awaiting = await sendAll(run, selected, rows, terminals, roles, selfKey, deps);
    reportProgress(selected, deps);
    await awaitProof(run, selected, awaiting, deps);
  } catch (error) {
    await store.save(run);
    return failure(error, run);
  }

  const finished = run.agents.every((a) => a.resumeStatus !== 'pending');
  if (finished) run.status = 'closed';
  await store.save(run);
  if (finished) await store.clearCurrent('pause', run.runId);
  const settled = selected.every((a) => a.resumeStatus === 'resumed' || a.resumeStatus === 'gone');
  return { outcome: 'done', exitCode: settled ? 0 : 1, run, error: null, rows: run.agents };
}

async function sendAll(run: Run, selected: AgentRecord[], rows: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, roles: Roles, selfKey: string | undefined, deps: ResumeDeps): Promise<Awaiting[]> {
  const awaiting: Awaiting[] = [];
  // The records change only inside the send loop, so a signal leaves the agents it never reached untouched.
  const pending = selected
    .map((agent) => {
      const located = locate(agent.paneKey, rows, terminals);
      return { agent, located, info: 'gone' in located ? agent : roleInfoOf(roles, agent.paneKey) };
    });

  // Workers and sessions first, then coordinators: a send order only.
  for (const { agent, located, info } of coordinatorsLast(pending, (p) => p.info.role)) {
    throwIfAborted(deps.signal);
    delete agent.resumeReason;
    // The session that runs resume is active, and a CONTINUE to it would wait behind this command.
    if (agent.paneKey === selfKey) {
      agent.resumeStatus = 'resumed';
      agent.resumeReason = 'self';
      continue;
    }
    if ('gone' in located) {
      agent.resumeStatus = 'gone';
      agent.resumeReason = located.gone;
      continue;
    }
    Object.assign(agent, { role: info.role, orchestrationRunIds: info.orchestrationRunIds, ...identityOf(located.row) });
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
    const result = await deps.port.send(handle, continueMessage(run.reason)).catch(() => ({ accepted: false as const }));
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

async function awaitProof(run: Run, selected: AgentRecord[], awaiting: Awaiting[], deps: ResumeDeps): Promise<void> {
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
    reportProgress(selected, deps);
    if (now - lastSend >= PROOF_WINDOW_MS) break;
  }
  for (const { agent } of open) agent.resumeReason = 'no-proof';
}

function reportProgress(selected: AgentRecord[], deps: ResumeDeps): void {
  const live = selected.filter((a) => a.resumeStatus !== 'gone');
  deps.onProgress?.({ resumed: live.filter((a) => a.resumeStatus === 'resumed').length, total: live.length });
}
