import { randomBytes } from 'node:crypto';
import { Interrupted } from './abort.js';
import { ALL_AGENTS, combineSets, isFiltered, resolveFilters, type FilterSources, type Subject } from './filters.js';
import { withRetry } from './retry.js';
import type { AgentRecord, AgentRow, BroadcastRecord, Clock, FilterSet, FilterSpec, GroupFilter, LocateReason, OrcaPort, RepoRow, Role, Run, RunRow, RunSummary, TerminalRow, TranscriptIdentity, TranscriptMark, WorkerRow, WorktreeRow } from './types.js';

export const POLL_INTERVAL_MS = 2000;

export const BROADCAST_OPEN_MESSAGE = 'A broadcast is open; run broadcast with no text to keep waiting, or close it first.';

export function randomToken(): string {
  return randomBytes(4).toString('hex');
}

// Any state other than working or done (waiting, or one we do not know) is treated like a permission prompt.
export function isWaitingLike(state: string): boolean {
  return state !== 'working' && state !== 'done';
}

// The rows a broadcast targets: Claude agents that are working or done.
export const isSendable = (row: AgentRow): boolean => row.agentType === 'claude' && !isWaitingLike(row.state);

// The turn has ended but Orca still shows the agent working: background work runs (a shell, or something else).
const isBackground = (row: AgentRow): boolean => row.state === 'working' && row.mainAgentState === 'done';

// The reason of an agent that has not answered yet and is not on a permission prompt.
export const busyReason = (row: AgentRow): 'background' | 'still-working' => (isBackground(row) ? 'background' : 'still-working');

// A reply written since the baseline. Orca shows null mid-turn, and that is not a reply.
export function hasNewReply(baseline: string | null, row: AgentRow): boolean {
  return row.lastAssistantMessage !== null && row.lastAssistantMessage !== baseline;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// The id of a pause run or a broadcast record: the compact ISO time, then the token.
export function recordId(ms: number, token: string): string {
  return `${iso(ms).replace(/[-:.]/g, '')}-${token}`;
}

export function newestByPane(rows: AgentRow[]): Map<string, AgentRow> {
  const byPane = new Map<string, AgentRow>();
  for (const row of rows) {
    const current = byPane.get(row.paneKey);
    if (!current || row.stateStartedAt > current.stateStartedAt) byPane.set(row.paneKey, row);
  }
  return byPane;
}

function terminalsByPane(terminals: TerminalRow[]): Map<string, TerminalRow> {
  return new Map(terminals.map((t) => [t.paneKey, t]));
}

export interface ListDeps {
  port: OrcaPort;
  clock: Clock;
  signal?: AbortSignal;
}

export async function listAgentsFresh({ port, clock, signal }: ListDeps): Promise<Map<string, AgentRow>> {
  return newestByPane(await withRetry(() => port.listAgents(), clock, signal));
}

// Waits for every promise, then fails with the interrupt if there was one, else with the first failure.
async function allSettledOrThrow<T extends unknown[]>(promises: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const failures = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  if (failures.length > 0) throw failures.find((reason) => reason instanceof Interrupted) ?? failures[0];
  return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as T;
}

export async function listFresh({ port, clock, signal }: ListDeps): Promise<[Map<string, AgentRow>, Map<string, TerminalRow>]> {
  const [rows, terminals] = await allSettledOrThrow([listAgentsFresh({ port, clock, signal }), withRetry(() => port.listTerminals(), clock, signal)]);
  return [rows, terminalsByPane(terminals)];
}

export interface RoleInfo {
  role: Role;
  orchestrationRunIds: string[];
}

// The last non-blank line of a reply, trimmed, with one wrapping backtick pair removed.
function lastLine(message: string | null): string | null {
  const last = message?.trimEnd().split(/\r?\n/).at(-1)?.trim();
  if (!last) return null;
  return last.length >= 2 && last.startsWith('`') && last.endsWith('`') ? last.slice(1, -1) : last;
}

// The exact last-line check. It lives here so the later ack proof uses the same normalisation as the pause proof.
export function endsWithLine(message: string | null, line: string): boolean {
  return lastLine(message) === line;
}

// The last line of every broadcast message: the agent proves it handled the message by ending its reply with it.
export const ackLine = (token: string) => `ORCA-ACK ${token}`;

// The ack proof: the message was sent, the agent is not on a permission prompt, and its new reply ends with the ack line.
export function proves(target: { messagePending: boolean; baseline: string | null }, row: AgentRow, token: string): boolean {
  return !target.messagePending && !isWaitingLike(row.state) && hasNewReply(target.baseline, row) && endsWithLine(row.lastAssistantMessage, ackLine(token));
}

// The read positions of one run, and the targets whose transcript counted as missing in it, by pane key.
export interface TranscriptReadState {
  positions: Map<string, number>;
  missing: Set<string>;
}

// The offset and file id of a transcript just before a send; null when it cannot be read.
export async function markTranscript(port: OrcaPort, identity: TranscriptIdentity): Promise<TranscriptMark | null> {
  const read = await port.readTranscript(identity, 0, null, []);
  return read.kind === 'ok' ? { identity, position: read.position, fileId: read.fileId } : null;
}

// True when a reply that ended a turn since the mark has `line` as its last line. A missing transcript counts as no proof for the rest of the run.
export async function transcriptProof(port: OrcaPort, paneKey: string, mark: TranscriptMark, line: string, state: TranscriptReadState): Promise<boolean> {
  if (state.missing.has(paneKey)) return false;
  const read = await port.readTranscript(mark.identity, state.positions.get(paneKey) ?? mark.position, mark.fileId, []);
  if (read.kind === 'missing') {
    state.missing.add(paneKey);
    return false;
  }
  state.positions.set(paneKey, read.position);
  return read.replies.some((reply) => endsWithLine(reply, line));
}

// A target is due a send when its message is still pending, its last send did not fail, and the agent is not on a permission prompt.
export const sendDue = (target: { messagePending: boolean; reason: string | null }, row: Pick<AgentRow, 'state'>): boolean =>
  target.messagePending && target.reason !== 'send-failed' && !isWaitingLike(row.state);

// Role and run ids of every live agent, by pane key. An agent that is not live has no entry.
export type Roles = Map<string, RoleInfo>;

export const roleInfoOf = (roles: Roles, paneKey: string): RoleInfo => roles.get(paneKey) ?? { role: 'session', orchestrationRunIds: [] };

// A coordinator or worker that is live in a restored terminal reads as `session` (its run and worker handles are stale),
// so a record keeps its role and run ids then. Any other live role replaces the record, as it always did.
export const keepRecordedRole = (live: RoleInfo, recorded: RoleInfo | undefined): RoleInfo =>
  live.role === 'session' && recorded ? { role: recorded.role, orchestrationRunIds: recorded.orchestrationRunIds } : live;

export const recordedRoleInfo = (roles: Roles, agent: AgentRecord): RoleInfo => keepRecordedRole(roleInfoOf(roles, agent.paneKey), agent);

// Roles come from the parent links of the live agents, which survive an Orca restart, and from the handles in run-list and worker-list,
// which a restart makes stale. The handles are used only inside this one pass, never stored.
export function computeRoles(agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, runs: RunRow[], workers: WorkerRow[]): Roles {
  const live = new Map<string, { row: AgentRow; handle: string }>();
  for (const paneKey of agents.keys()) {
    const found = locate(paneKey, agents, terminals);
    if (!('gone' in found)) live.set(paneKey, found);
  }

  const coordinatorHandles = new Set<string>();
  const workerHandles = new Set<string>();
  const idsOfHandle = new Map<string, Set<string>>();
  const addId = (handle: string, id: string | null) => {
    if (id) idsOfHandle.set(handle, (idsOfHandle.get(handle) ?? new Set()).add(id));
  };
  for (const run of runs) {
    if (!run.coordinatorHandle) continue;
    coordinatorHandles.add(run.coordinatorHandle);
    addId(run.coordinatorHandle, run.id);
  }
  for (const worker of workers) {
    workerHandles.add(worker.handle);
    addId(worker.handle, worker.runId);
  }

  // Only a direct link to another live agent counts; a link to the agent's own pane is ignored.
  const parentOf = (paneKey: string): string | null => {
    const parent = live.get(paneKey)?.row.parentPaneKey;
    return parent && parent !== paneKey && live.has(parent) ? parent : null;
  };
  const parents = new Set([...live.keys()].flatMap((paneKey) => parentOf(paneKey) ?? []));
  const own = new Map([...live].map(([paneKey, { handle }]) => [paneKey, [...(idsOfHandle.get(handle) ?? [])].sort()]));

  const roles: Roles = new Map();
  for (const [paneKey, { handle }] of live) {
    const parent = parentOf(paneKey);
    const role: Role = coordinatorHandles.has(handle) || parents.has(paneKey) ? 'coordinator' : workerHandles.has(handle) || parent ? 'worker' : 'session';
    // A worker without a run of its own takes the own run ids of its parent (one hop, never inherited ones).
    const ids = own.get(paneKey) as string[];
    roles.set(paneKey, { role, orchestrationRunIds: role === 'worker' && ids.length === 0 && parent ? [...(own.get(parent) as string[])] : ids });
  }
  return roles;
}

export interface Snapshot {
  agents: Map<string, AgentRow>;
  terminals: Map<string, TerminalRow>;
  roles: Roles;
  /** Every orchestration run id of the run list and the worker list: the values `--run` can name. */
  runIds: string[];
  /** The Orca runtime ID of the same `worktree ps` call that gave `agents`; null when Orca sent none. */
  runtimeId: string | null;
  runs: RunRow[];
  workers: WorkerRow[];
}

// One pass of all four listings, taken together: roles are never computed from listings of different moments.
export async function listSnapshot(deps: ListDeps): Promise<Snapshot> {
  const { port, clock, signal } = deps;
  const [{ rows, runtimeId }, terminalRows, runs, workers] = await allSettledOrThrow([
    withRetry(() => port.listAgentsWithRuntime(), clock, signal),
    withRetry(() => port.listTerminals(), clock, signal),
    withRetry(() => port.listRuns(), clock, signal),
    withRetry(() => port.listWorkers(), clock, signal),
  ]);
  const agents = newestByPane(rows);
  const terminals = terminalsByPane(terminalRows);
  const runIds = [...new Set([...runs.map((run) => run.id), ...workers.flatMap((worker) => (worker.runId ? [worker.runId] : []))])];
  return { agents, terminals, roles: computeRoles(agents, terminals, runs, workers), runIds, runtimeId, runs, workers };
}

// The identity fields that filters match and that a poll refreshes in a record: the ids and the worktree path.
export const identityOf = (row: AgentRow) => ({ repoId: row.repoId, worktreeId: row.worktreeId, worktreePath: row.path });

// A run written before filters existed has no scope, or agents without a repo id.
export function assertCurrentFormat(run: Run): void {
  if (!run.scope || run.agents.some((agent) => agent.repoId === undefined)) {
    throw new Error('the open run was written by an older version of orca-broadcast: close it with `orca-broadcast close`, and continue its paused agents by hand');
  }
}

// What the filter values are resolved against: the live listings, and the agents saved in a record.
export interface LiveSources {
  runIds: string[];
  repos: RepoRow[];
  worktrees: WorktreeRow[];
}

// Adds the repo list and the worktree list (every worktree, with or without an agent) to a snapshot. Callers ask for it only when a filter is given.
export async function liveSources({ runIds }: Pick<Snapshot, 'runIds'>, { port, clock, signal }: ListDeps): Promise<LiveSources> {
  const [repos, worktrees] = await allSettledOrThrow([withRetry(() => port.listRepos(), clock, signal), withRetry(() => port.listWorktrees(), clock, signal)]);
  return { runIds, repos, worktrees };
}

// What a saved record keeps of an agent's identity, which filter values resolve against.
export type RecordedIdentity = Pick<AgentRecord, 'repoId' | 'repo' | 'worktreeId' | 'worktreePath' | 'worktree' | 'orchestrationRunIds'>;

// Resolves once per invocation. Without filters or a group the set matches every agent. Each group is resolved on its own, then narrowed by the ad-hoc filters; several groups are a union of those sets.
export function resolveFilterSet(spec: FilterSpec, live: LiveSources | null, recorded: RecordedIdentity[], cwd: string = process.cwd(), groups: GroupFilter[] = []): FilterSet {
  if (!isFiltered(spec, groups)) return ALL_AGENTS;
  const sources: FilterSources = {
    repos: [...(live?.repos ?? []).map((repo) => ({ id: repo.id, path: repo.path, name: repo.displayName })), ...recorded.map((agent) => ({ id: agent.repoId, name: agent.repo }))],
    worktrees: [...(live?.worktrees ?? []).map((worktree) => ({ id: worktree.id, path: worktree.path, name: worktree.displayName, repoId: worktree.repoId })), ...recorded.map((agent) => ({ id: agent.worktreeId, path: agent.worktreePath, name: agent.worktree, repoId: agent.repoId }))],
    runIds: [...new Set([...(live?.runIds ?? []), ...recorded.flatMap((agent) => agent.orchestrationRunIds)])],
  };
  const adhoc = resolveFilters(spec, sources, cwd);
  if (groups.length === 0) return adhoc;
  const sets = groups.map((group) => {
    try {
      return combineSets(resolveFilters(group.spec, sources, cwd), adhoc, group.name);
    } catch (error) {
      throw new Error(`group ${group.name}: ${(error as Error).message}`);
    }
  });
  return sets.length === 1 ? (sets[0] as FilterSet) : { typed: {}, anyOf: sets };
}

// The values a live row is matched on.
export const subjectOfRow = (row: AgentRow, roles: Roles): Subject => ({ ...identityOf(row), ...roleInfoOf(roles, row.paneKey) });

// Stable partitions: coordinators come first (or last), and each group keeps its order.
const splitCoordinators = <T>(items: T[], roleOfItem: (item: T) => Role): [T[], T[]] => [items.filter((item) => roleOfItem(item) === 'coordinator'), items.filter((item) => roleOfItem(item) !== 'coordinator')];

export function coordinatorsFirst<T>(items: T[], roleOfItem: (item: T) => Role): T[] {
  return splitCoordinators(items, roleOfItem).flat();
}

export function coordinatorsLast<T>(items: T[], roleOfItem: (item: T) => Role): T[] {
  return splitCoordinators(items, roleOfItem).reverse().flat();
}

// The process that runs a broadcast: its pid, and its start time when the store can read it.
export function setPid(record: Pick<BroadcastRecord, 'pid' | 'startTime'>, { pid, startTime }: { pid: number; startTime?: string }): void {
  record.pid = pid;
  if (startTime === undefined) delete record.startTime;
  else record.startTime = startTime;
}

export function clearPid(record: Pick<BroadcastRecord, 'pid' | 'startTime'>): void {
  delete record.pid;
  delete record.startTime;
}

// The process no longer runs this broadcast: drop its pid, and close the record when no target can still progress.
export function releaseBroadcast(record: BroadcastRecord): void {
  clearPid(record);
  if (record.targets.every((t) => t.status !== 'pending')) record.status = 'closed';
}

export function failure(error: unknown, run: Run | null): RunSummary {
  const exitCode = error instanceof Interrupted ? 130 : 2;
  return { outcome: 'error', exitCode, run, error: (error as Error).message, rows: run?.agents ?? [] };
}

export function nothingToDo(): RunSummary {
  return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [] };
}

// Runs a command that may collect warning lines on the way (recovery notes, an abandoned broadcast) and adds them to its summary.
export async function withWarnings(run: (warnings: string[]) => Promise<RunSummary>): Promise<RunSummary> {
  const warnings: string[] = [];
  const summary = await run(warnings);
  return warnings.length > 0 ? { ...summary, warnings } : summary;
}

export function cancelled(): RunSummary {
  return { outcome: 'error', exitCode: 2, run: null, error: 'cancelled: nothing was sent', rows: [] };
}

export type Located = { gone: LocateReason } | { row: AgentRow; handle: string };

// The Locate rule shared by pause and resume: the checks run in this order.
export function locate(paneKey: string, rows: Map<string, AgentRow>, terminals: Map<string, TerminalRow>): Located {
  const terminal = terminals.get(paneKey);
  if (!terminal) return { gone: 'terminal-closed' };
  if (terminal.orphaned) return { gone: 'terminal-orphaned' };
  const row = rows.get(paneKey);
  if (!row) return { gone: 'agent-missing' };
  if (terminal.agentIdentity !== 'claude') return { gone: 'agent-exited' };
  return { row, handle: terminal.handle };
}
