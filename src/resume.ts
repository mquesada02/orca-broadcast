import { sleepOrAbort, throwIfAborted } from './abort.js';
import { continueSentence, type Preset } from './reasons.js';
import { liveSessionIds } from './recover-classify.js';
import { workerItems, workersSentence } from './recover-prompt.js';
import { isFiltered, matches, NO_FILTERS } from './filters.js';
import { autoRoster, type AutoRoster } from './roster-cmd.js';
import { applySessionMatches, matchSessions } from './session-match.js';
import { sessionsByPane } from './roster.js';
import { assertCurrentFormat, cancelled, coordinatorsLast, failure, identityOf, iso, listAgentsFresh, listSnapshot, markTranscript, nothingToDo, locate, POLL_INTERVAL_MS, liveSources, recordedRoleInfo, resolveFilterSet, userEntryProof, withWarnings, type Roles, type Snapshot, type TranscriptReadState } from './shared.js';
import type { RecordStore } from './store.js';
import type { AgentRecord, AgentRow, Clock, Confirm, ConfirmTarget, ContinueBaseline, FilterSpec, GroupFilter, MissingWorker, OrcaPort, ResumeProgress, ResumeReason, Run, RunSummary, SessionRecord, SessionScan, TerminalRow } from './types.js';

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

// `workers` are the missing workers of a coordinator that `recover` stored and that are not live again.
export const continueMessage = (reason?: Preset, workers: MissingWorker[] = []): string =>
  `[orca-broadcast] CONTINUE. ${continueSentence(reason)} Continue your task from the note in your last pause reply.${workersSentence(workerItems([], workers))}`;

function movedSince(row: AgentRow, baseline: ContinueBaseline): boolean {
  return row.stateStartedAt !== baseline.stateStartedAt || row.lastAssistantMessage !== baseline.lastAssistantMessage;
}

// What one invocation knows about the transcripts: the scan records of the start scan, the read state, and the panes whose CONTINUE entry was found.
interface TranscriptProof {
  sessions: Map<string, SessionRecord>;
  reads: TranscriptReadState;
  found: Set<string>;
}

const changeCheck = (agent: AgentRecord, row: AgentRow): boolean => Boolean(agent.continueSentAt && agent.continueBaseline && movedSince(row, agent.continueBaseline));

// With a CONTINUE mark: resumed when a user entry since it holds a sent CONTINUE text; today's change check only when the transcript is missing. Without a mark: today's change check.
async function isProven(agent: AgentRecord, row: AgentRow, port: OrcaPort, proof: TranscriptProof): Promise<boolean> {
  if (proof.found.has(agent.paneKey)) return true;
  if (agent.continueTranscript && agent.continueTexts?.length) {
    const found = await userEntryProof(port, agent.paneKey, agent.continueTranscript, agent.continueTexts, proof.reads);
    if (found !== null) {
      if (found) proof.found.add(agent.paneKey);
      return found;
    }
  }
  return changeCheck(agent, row);
}

const isSendable = (row: AgentRow): boolean => row.state === 'working' || row.state === 'done';

// The agents sendAll would message, coordinators last.
async function sendTargets(selected: AgentRecord[], rows: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, roles: Roles, selfKey: string | undefined, port: OrcaPort, proof: TranscriptProof): Promise<ConfirmTarget[]> {
  const targets: ConfirmTarget[] = [];
  for (const agent of selected) {
    if (agent.paneKey === selfKey) continue;
    const located = locate(agent.paneKey, rows, terminals);
    if ('gone' in located || (await isProven(agent, located.row, port, proof)) || !isSendable(located.row)) continue;
    targets.push({ repo: agent.repo, worktree: agent.worktree, role: recordedRoleInfo(roles, agent).role });
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
  // The sessions that are live at the start of the run, when the scan of the start save worked: a stored missing worker among them is not listed.
  let liveSessions: Set<string> | null = null;
  const proof: TranscriptProof = { sessions: new Map(), reads: { positions: new Map(), missing: new Set() }, found: new Set() };
  try {
    const snapshot = await listSnapshot(deps);
    seen.newest = snapshot;
    ({ agents: rows, terminals, roles } = snapshot);
    const scan: SessionScan | null = await roster.start(snapshot);
    liveSessions = scan === null ? null : liveSessionIds(snapshot, scan);
    // In memory only: nothing saves the run before the user's yes, so a "no" or a failure leaves the file as it was.
    applySessionMatches(run.agents, matchSessions(run.agents, snapshot, scan, warnings, deps.signal));
    proof.sessions = scan ? sessionsByPane(scan) : new Map();
    const filters = deps.filters ?? NO_FILTERS;
    const set = resolveFilterSet(filters, isFiltered(filters, deps.groups) ? await liveSources(snapshot, deps) : null, run.agents, deps.cwd, deps.groups);
    selected = run.agents.filter((a) => a.resumeStatus === 'pending' && matches(set, a));
    if (isFiltered(filters, deps.groups) && selected.length === 0) return nothingToDo();
    if (deps.confirm) {
      const targets = await sendTargets(selected, rows, terminals, roles, selfKey, port, proof);
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
    const awaiting = await sendAll(run, selected, rows, terminals, roles, selfKey, deps, liveSessions, proof);
    reportProgress(selected, deps);
    await awaitProof(run, selected, awaiting, deps, proof);
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

async function sendAll(run: Run, selected: AgentRecord[], rows: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, roles: Roles, selfKey: string | undefined, deps: ResumeDeps, liveSessions: Set<string> | null, proof: TranscriptProof): Promise<Awaiting[]> {
  const awaiting: Awaiting[] = [];
  // The records change only inside the send loop, so a signal leaves the agents it never reached untouched.
  const pending = selected
    .map((agent) => {
      const located = locate(agent.paneKey, rows, terminals);
      return { agent, located, info: 'gone' in located ? agent : recordedRoleInfo(roles, agent) };
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
    if (await isProven(agent, row, deps.port, proof)) {
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
    // The offset is taken just before the send, from the start scan; the first mark stays through a re-send.
    const identity = proof.sessions.get(agent.paneKey)?.transcript;
    const taken = identity && !agent.continueTranscript ? await markTranscript(deps.port, identity) : null;
    const text = continueMessage(run.reason, (agent.missingWorkers ?? []).filter((worker) => !liveSessions?.has(worker.sessionId)));
    const result = await deps.port.send(handle, text).catch(() => ({ accepted: false as const }));
    if (!result.accepted) {
      agent.resumeReason = 'send-failed';
      continue;
    }
    // Kept only after an accepted send. A new mark starts a new read.
    if (taken) {
      agent.continueTranscript = taken;
      agent.continueTexts = [];
      proof.reads.positions.delete(agent.paneKey);
      proof.reads.missing.delete(agent.paneKey);
    }
    if (agent.continueTranscript && !agent.continueTexts?.includes(text)) agent.continueTexts = [...(agent.continueTexts ?? []), text];
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

async function awaitProof(run: Run, selected: AgentRecord[], awaiting: Awaiting[], deps: ResumeDeps, proof: TranscriptProof): Promise<void> {
  const lastSend = Math.max(...awaiting.map((a) => a.sentAt));
  let open = awaiting;
  while (open.length > 0) {
    await sleepOrAbort(deps.clock, POLL_INTERVAL_MS, deps.signal);
    const rows = await listAgentsFresh(deps);
    const now = deps.clock.now();
    const stillOpen: Awaiting[] = [];
    for (const entry of open) {
      const { agent, sentAt } = entry;
      const row = rows.get(agent.paneKey);
      const proven = now - sentAt <= PROOF_WINDOW_MS && row && agent.continueBaseline && (await isProven(agent, row, deps.port, proof));
      if (proven) {
        agent.resumeStatus = 'resumed';
        delete agent.resumeReason;
      } else {
        stillOpen.push(entry);
      }
    }
    open = stillOpen;
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
