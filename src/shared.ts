import { Interrupted } from './abort.js';
import { withRetry } from './retry.js';
import type { AgentRow, Clock, OrcaPort, ResumeReason, Role, Run, RunRow, RunSummary, TerminalRow, WorkerRow } from './types.js';

export const POLL_INTERVAL_MS = 2000;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
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

export async function listFresh({ port, clock, signal }: ListDeps): Promise<[Map<string, AgentRow>, Map<string, TerminalRow>]> {
  const [rows, terminals] = await Promise.allSettled([listAgentsFresh({ port, clock, signal }), withRetry(() => port.listTerminals(), clock, signal)]);
  if (rows.status === 'fulfilled' && terminals.status === 'fulfilled') return [rows.value, terminalsByPane(terminals.value)];
  const failures = [rows, terminals].flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  throw failures.find((reason) => reason instanceof Interrupted) ?? failures[0];
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
// Role and run ids of every live agent, by pane key. An agent that is not live has no entry.
export type Roles = Map<string, RoleInfo>;

const NO_ROLE: RoleInfo = { role: 'session', orchestrationRunIds: [] };

export const roleInfoOf = (roles: Roles, paneKey: string): RoleInfo => roles.get(paneKey) ?? NO_ROLE;

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
  const own = (paneKey: string): string[] => [...(idsOfHandle.get((live.get(paneKey) as { handle: string }).handle) ?? [])].sort();

  const roles: Roles = new Map();
  for (const [paneKey, { handle }] of live) {
    const parent = parentOf(paneKey);
    const role: Role = coordinatorHandles.has(handle) || parents.has(paneKey) ? 'coordinator' : workerHandles.has(handle) || parent ? 'worker' : 'session';
    // A worker without a run of its own takes the own run ids of its parent (one hop, never inherited ones).
    const ids = own(paneKey);
    roles.set(paneKey, { role, orchestrationRunIds: role === 'worker' && ids.length === 0 && parent ? own(parent) : ids });
  }
  return roles;
}

export interface Snapshot {
  agents: Map<string, AgentRow>;
  terminals: Map<string, TerminalRow>;
  roles: Roles;
}

// One pass of all four listings, taken together: roles are never computed from listings of different moments.
export async function listSnapshot(deps: ListDeps): Promise<Snapshot> {
  const { port, clock, signal } = deps;
  const [agents, terminals] = await listFresh(deps);
  const runs = await withRetry(() => port.listRuns(), clock, signal);
  const workers = await withRetry(() => port.listWorkers(), clock, signal);
  return { agents, terminals, roles: computeRoles(agents, terminals, runs, workers) };
}

// Stable partitions: coordinators come first (or last), and each group keeps its order.
export function coordinatorsFirst<T>(items: T[], roleOfItem: (item: T) => Role): T[] {
  return [...items.filter((item) => roleOfItem(item) === 'coordinator'), ...items.filter((item) => roleOfItem(item) !== 'coordinator')];
}

export function coordinatorsLast<T>(items: T[], roleOfItem: (item: T) => Role): T[] {
  return [...items.filter((item) => roleOfItem(item) !== 'coordinator'), ...items.filter((item) => roleOfItem(item) === 'coordinator')];
}

export function failure(error: unknown, run: Run | null): RunSummary {
  const exitCode = error instanceof Interrupted ? 130 : 2;
  return { outcome: 'error', exitCode, run, error: (error as Error).message, rows: run?.agents ?? [] };
}

export function cancelled(): RunSummary {
  return { outcome: 'error', exitCode: 2, run: null, error: 'cancelled: nothing was sent', rows: [] };
}

export type Located = { gone: ResumeReason } | { row: AgentRow; handle: string };

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
