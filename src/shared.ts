import type { AgentRow, OrcaPort, ResumeReason, Run, RunSummary, TerminalRow } from './types.js';

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

export async function listFresh(port: OrcaPort): Promise<[Map<string, AgentRow>, Map<string, TerminalRow>]> {
  const [rows, terminals] = await Promise.all([port.listAgents(), port.listTerminals()]);
  return [newestByPane(rows), terminalsByPane(terminals)];
}

export function failure(error: unknown, run: Run | null): RunSummary {
  return { outcome: 'error', exitCode: 2, run, error: (error as Error).message, rows: run?.agents ?? [] };
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
