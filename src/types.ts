export interface AgentRow {
  paneKey: string;
  worktreeId: string;
  worktree: string;
  repo: string;
  agentType: string;
  state: string;
  stateStartedAt: number;
  lastAssistantMessage: string | null;
}

export interface TerminalRow {
  handle: string;
  paneKey: string;
  orphaned: boolean;
  agentIdentity: string | null;
}

export interface RunRow {
  id: string;
  coordinatorHandle: string;
}

export type SendResult = { accepted: true } | { accepted: false; reason: string };

export interface OrcaPort {
  listAgents(): Promise<AgentRow[]>;
  listTerminals(): Promise<TerminalRow[]>;
  listRuns(): Promise<RunRow[]>;
  send(handle: string, text: string): Promise<SendResult>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type PauseStatus = 'confirmed' | 'unconfirmed';
export type PauseReason = 'still-working' | 'waiting-permission' | 'done-no-token' | 'send-failed';

export interface AgentRecord {
  paneKey: string;
  worktreeId: string;
  worktree: string;
  repo: string;
  role: 'worker';
  lastHandle: string | null;
  pauseStatus: PauseStatus;
  pauseReason: PauseReason | null;
  pauseBaseline: string | null;
  messagePending: boolean;
  confirmedAt: string | null;
  wakeCount: number;
  resumeStatus: 'pending';
}

export interface Progress {
  confirmed: number;
  total: number;
  reasons: Partial<Record<PauseReason, number>>;
  remainingMs: number;
}

export interface Run {
  runId: string;
  token: string;
  startedAt: string;
  status: 'open' | 'closed';
  agents: AgentRecord[];
}
