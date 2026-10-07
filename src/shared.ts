import { Interrupted } from './abort.js';
import { withRetry } from './retry.js';
import type { AgentRow, Clock, OrcaPort, ResumeReason, Role, Run, RunSummary, TerminalRow } from './types.js';

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

export async function listCoordinators({ port, clock, signal }: ListDeps): Promise<Set<string>> {
  return new Set((await withRetry(() => port.listRuns(), clock, signal)).map((run) => run.coordinatorHandle));
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

export function roleOf(handle: string, coordinators: Set<string>): Role {
  return coordinators.has(handle) ? 'coordinator' : 'worker';
}

// A stable partition: items of the given role come first, and each group keeps its order.
export function roleFirst<T>(items: T[], first: Role, roleOfItem: (item: T) => Role): T[] {
  return [...items.filter((item) => roleOfItem(item) === first), ...items.filter((item) => roleOfItem(item) !== first)];
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
