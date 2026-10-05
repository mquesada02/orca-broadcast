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

export interface ConfirmTarget {
  repo: string;
  worktree: string;
  role: Role;
}

// Asked once, before the first send: false means the user said no.
export type Confirm = (targets: ConfirmTarget[], signal?: AbortSignal) => Promise<boolean>;

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type PauseStatus = 'confirmed' | 'unconfirmed';
export type PauseReason = 'still-working' | 'waiting-permission' | 'done-no-token' | 'send-failed' | 're-woken' | 'self';
export type ResumeStatus = 'pending' | 'resumed' | 'gone' | 'abandoned';
export type ResumeReason =
  | 'terminal-closed'
  | 'terminal-orphaned'
  | 'agent-missing'
  | 'agent-exited'
  | 'waiting-permission'
  | 'send-failed'
  | 'no-proof'
  | 'queued-while-working';

export interface ContinueBaseline {
  stateStartedAt: number;
  lastAssistantMessage: string | null;
}

export type Role = 'coordinator' | 'worker';

export interface AgentRecord {
  paneKey: string;
  worktreeId: string;
  worktree: string;
  repo: string;
  role: Role;
  lastHandle: string | null;
  pauseStatus: PauseStatus;
  pauseReason: PauseReason | null;
  pauseBaseline: string | null;
  messagePending: boolean;
  confirmedAt: string | null;
  wakeCount: number;
  resumeStatus: ResumeStatus;
  resumeReason?: ResumeReason;
  continueBaseline?: ContinueBaseline;
  continueSentAt?: string;
}

export interface Progress {
  confirmed: number;
  total: number;
  reasons: Partial<Record<PauseReason, number>>;
  remainingMs: number;
}

export interface ResumeProgress {
  resumed: number;
  total: number;
}

export interface RunSummary {
  outcome: 'done' | 'nothing-to-do' | 'error';
  exitCode: 0 | 1 | 2 | 130;
  run: Run | null;
  error: string | null;
  rows: AgentRecord[];
  self?: AgentRecord | null;
}

export interface Run {
  runId: string;
  token: string;
  startedAt: string;
  status: 'open' | 'closed';
  agents: AgentRecord[];
}
