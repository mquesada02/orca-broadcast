import { randomBytes } from 'node:crypto';
import type { RecordStore } from './store.js';
import type { AgentRecord, AgentRow, Clock, OrcaPort, PauseReason, Run, TerminalRow } from './types.js';

const POLL_INTERVAL_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface PauseDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
  newToken?: () => string;
  onProgress?: (progress: Progress) => void;
}

export interface Progress {
  confirmed: number;
  total: number;
  reasons: Partial<Record<PauseReason, number>>;
  remainingMs: number;
}

export interface PauseSummary {
  outcome: 'done' | 'nothing-to-do' | 'error';
  exitCode: 0 | 1 | 2;
  run: Run | null;
  error: string | null;
  rows: AgentRecord[];
}

export function pauseMessage(token: string): string {
  return (
    '[orca-pause] The user is leaving and the network will drop. Finish the step you are on now. ' +
    'Do not start a new step and do not commit. Then end your turn with a short note: where you stopped, ' +
    `and your next step. The last line of your reply must be exactly: ORCA-PAUSED ${token}. ` +
    'After that, do nothing until you get a message that starts with [orca-pause] CONTINUE.'
  );
}

function randomToken(): string {
  return randomBytes(4).toString('hex');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function lastLine(message: string | null): string | null {
  if (message === null) return null;
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines.at(-1);
  if (last === undefined) return null;
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

function newestByPane(rows: AgentRow[]): Map<string, AgentRow> {
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

function isSettled(agent: AgentRecord): boolean {
  return agent.pauseStatus === 'confirmed' || agent.pauseReason === 'send-failed';
}

function reasonFromState(state: string): PauseReason | null {
  if (state === 'working') return 'still-working';
  if (state === 'waiting') return 'waiting-permission';
  if (state === 'done') return 'done-no-token';
  return null;
}

function failure(error: unknown, run: Run | null): PauseSummary {
  return { outcome: 'error', exitCode: 2, run, error: (error as Error).message, rows: run?.agents ?? [] };
}

export async function pause(timeoutMs: number, deps: PauseDeps): Promise<PauseSummary> {
  const { port, clock, store } = deps;

  if (await store.hasOpenRun()) {
    return failure(
      new Error(
        `an open pause run already exists in ${store.dir}; extending it is not supported yet, ` +
          'so until resume and close exist, close it by hand (set its status to "closed" and delete the current file) before pausing again',
      ),
      null,
    );
  }

  let agents: Map<string, AgentRow>;
  let terminals: Map<string, TerminalRow>;
  try {
    [agents, terminals] = await listFresh(port);
  } catch (error) {
    return failure(error, null);
  }

  const discovered = [...agents.values()].filter((a) => a.agentType === 'claude' && a.state === 'working');
  if (discovered.length === 0) {
    return { outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [] };
  }

  const startedAt = clock.now();
  const token = (deps.newToken ?? randomToken)();
  const run: Run = {
    runId: `${iso(startedAt).replace(/[-:.]/g, '')}-${token}`,
    token,
    startedAt: iso(startedAt),
    status: 'open',
    agents: discovered.map((row) => {
      const terminal = terminals.get(row.paneKey);
      return {
        paneKey: row.paneKey,
        worktreeId: row.worktreeId,
        worktree: row.worktree,
        repo: row.repo,
        role: 'worker',
        lastHandle: terminal?.handle ?? null,
        pauseStatus: 'unconfirmed',
        pauseReason: terminal ? 'still-working' : 'send-failed',
        pauseBaseline: row.lastAssistantMessage,
        messagePending: true,
        confirmedAt: null,
        wakeCount: 0,
        resumeStatus: 'pending',
      };
    }),
  };
  await store.save(run);
  await store.setCurrent(run.runId);

  try {
    while (true) {
      await poll(run, agents, terminals, deps);
      await store.save(run);
      reportProgress(run, startedAt + timeoutMs - clock.now(), deps);
      if (run.agents.every(isSettled)) break;
      await clock.sleep(POLL_INTERVAL_MS);
      if (clock.now() - startedAt >= timeoutMs) break;
      [agents, terminals] = await listFresh(port);
    }
  } catch (error) {
    await store.save(run);
    return failure(error, run);
  }

  const unconfirmed = run.agents.some((a) => a.pauseStatus === 'unconfirmed');
  return { outcome: 'done', exitCode: unconfirmed ? 1 : 0, run, error: null, rows: run.agents };
}

async function listFresh(port: OrcaPort): Promise<[Map<string, AgentRow>, Map<string, TerminalRow>]> {
  const [rows, terminals] = await Promise.all([port.listAgents(), port.listTerminals()]);
  return [newestByPane(rows), terminalsByPane(terminals)];
}

async function poll(run: Run, agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>, deps: PauseDeps): Promise<void> {
  for (const agent of run.agents) {
    const handle = terminals.get(agent.paneKey)?.handle;
    if (handle) agent.lastHandle = handle;

    const row = agents.get(agent.paneKey);
    if (!row || agent.pauseStatus !== 'unconfirmed') continue;
    if (provesPause(agent, row, run.token)) {
      agent.pauseStatus = 'confirmed';
      agent.pauseBaseline = row.lastAssistantMessage;
      agent.confirmedAt = iso(deps.clock.now());
      agent.pauseReason = null;
    } else if (!agent.messagePending && agent.pauseReason !== 'send-failed') {
      agent.pauseReason = reasonFromState(row.state) ?? agent.pauseReason;
    }
  }

  for (const agent of run.agents) {
    if (isSettled(agent) || !agent.messagePending) continue;
    const handle = terminals.get(agent.paneKey)?.handle;
    if (!handle) {
      agent.pauseReason = 'send-failed';
      continue;
    }
    await deps.store.save(run);
    const result = await deps.port.send(handle, pauseMessage(run.token));
    if (result.accepted) {
      agent.pauseBaseline = agents.get(agent.paneKey)?.lastAssistantMessage ?? agent.pauseBaseline;
      agent.messagePending = false;
    } else {
      agent.pauseReason = 'send-failed';
    }
  }
}

function reportProgress(run: Run, remainingMs: number, deps: PauseDeps): void {
  if (!deps.onProgress) return;
  const reasons: Progress['reasons'] = {};
  for (const agent of run.agents) {
    if (agent.pauseReason) reasons[agent.pauseReason] = (reasons[agent.pauseReason] ?? 0) + 1;
  }
  deps.onProgress({
    confirmed: run.agents.filter((a) => a.pauseStatus === 'confirmed').length,
    total: run.agents.length,
    reasons,
    remainingMs: Math.max(0, remainingMs),
  });
}
