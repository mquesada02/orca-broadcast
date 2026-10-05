import type { AgentRow, OrcaPort, Run, RunSummary, TerminalRow } from './types.js';

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

export function terminalsByPane(terminals: TerminalRow[]): Map<string, TerminalRow> {
  return new Map(terminals.map((t) => [t.paneKey, t]));
}

export async function listFresh(port: OrcaPort): Promise<[Map<string, AgentRow>, Map<string, TerminalRow>]> {
  const [rows, terminals] = await Promise.all([port.listAgents(), port.listTerminals()]);
  return [newestByPane(rows), terminalsByPane(terminals)];
}

export function failure(error: unknown, run: Run | null): RunSummary {
  return { outcome: 'error', exitCode: 2, run, error: (error as Error).message, rows: run?.agents ?? [] };
}
