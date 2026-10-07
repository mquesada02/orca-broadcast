import type { Preset } from './reasons.js';

export interface AgentRow {
  paneKey: string;
  parentPaneKey: string | null;
  worktreeId: string;
  worktree: string;
  repoId: string;
  path: string;
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
  coordinatorHandle: string | null;
}

export interface WorkerRow {
  handle: string;
  runId: string | null;
}

// A worktree Orca manages, whether or not an agent runs in it. `id` is the worktree id of `worktree ps` (`<repoId>::<path>`).
export interface WorktreeRow {
  id: string;
  repoId: string;
  path: string;
  displayName: string;
}

export interface RepoRow {
  id: string;
  path: string;
  displayName: string;
}

export type SendResult = { accepted: true } | { accepted: false; reason: string };

export interface OrcaPort {
  listAgents(): Promise<AgentRow[]>;
  listTerminals(): Promise<TerminalRow[]>;
  listRuns(): Promise<RunRow[]>;
  listWorkers(): Promise<WorkerRow[]>;
  listRepos(): Promise<RepoRow[]>;
  listWorktrees(): Promise<WorktreeRow[]>;
  send(handle: string, text: string): Promise<SendResult>;
}

export interface ConfirmTarget {
  repo: string;
  worktree: string;
  role: Role;
}

// What only a broadcast prompt shows: the exact message, and this session (null when it is not a live Claude agent).
export interface ConfirmDetails {
  message: string;
  self: ConfirmTarget | null;
}

// Asked once, before the first send: false means the user said no.
export type Confirm = (targets: ConfirmTarget[], signal?: AbortSignal, details?: ConfirmDetails) => Promise<boolean>;

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type PauseStatus = 'confirmed' | 'unconfirmed';
export type PauseReason = 'still-working' | 'waiting-permission' | 'done-no-token' | 'send-failed' | 're-woken' | 'self';
export type ResumeStatus = 'pending' | 'resumed' | 'gone' | 'abandoned';
// Why an agent cannot be located any more.
export type LocateReason = 'terminal-closed' | 'terminal-orphaned' | 'agent-missing' | 'agent-exited';
export type ResumeReason =
  | LocateReason
  | 'waiting-permission'
  | 'send-failed'
  | 'no-proof'
  | 'queued-while-working';

export interface ContinueBaseline {
  stateStartedAt: number;
  lastAssistantMessage: string | null;
}

export type Role = 'coordinator' | 'worker' | 'session';

export interface AgentRecord {
  paneKey: string;
  worktreeId: string;
  worktree: string;
  repo: string;
  repoId: string;
  worktreePath: string;
  role: Role;
  orchestrationRunIds: string[];
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
  /** The broadcast record that `broadcast` or `close` worked on; absent or null for the pause commands. */
  record?: BroadcastRecord | null;
  /** This session as `broadcast` shows it on its own line. */
  broadcastSelf?: ConfirmTarget | null;
  /** A line `close` prints on stderr, for example when it leaves a second open record untouched. */
  warning?: string;
}

// What the user typed for each filter kind, as stored for display.
export interface FilterSpec {
  repo: string[];
  worktree: string[];
  role: Role[];
  run: string[];
}

// One resolved filter set: a kind that is absent does not filter. A set with no kind matches every agent.
export interface FilterSet {
  repoIds?: string[];
  worktreeIds?: string[];
  roles?: Role[];
  runIds?: string[];
  typed: Partial<FilterSpec>;
}

export interface Run {
  runId: string;
  token: string;
  startedAt: string;
  status: 'open' | 'closed';
  reason?: Preset;
  /** The filter sets of every `pause` of this run, in order; a plain `pause` adds the empty set. */
  scope: FilterSet[];
  agents: AgentRecord[];
}

export type BroadcastStatus = 'pending' | 'acked' | 'gone' | 'abandoned';
export type BroadcastReason = LocateReason | 'waiting-permission' | 'still-working' | 'send-failed' | 'closed';

export interface BroadcastTarget {
  paneKey: string;
  repoId: string;
  repo: string;
  worktreeId: string;
  worktreePath: string;
  worktree: string;
  role: Role;
  orchestrationRunIds: string[];
  /** Informational only: a send always uses the handle of a fresh row. */
  lastHandle: string | null;
  /** The agent's last reply when the send was accepted. */
  baseline: string | null;
  /** True until a send is accepted. */
  messagePending: boolean;
  status: BroadcastStatus;
  reason: BroadcastReason | null;
}

// The store itself reads only id, createdAt and status.
export interface BroadcastRecord {
  id: string;
  token: string;
  text: string;
  createdAt: string;
  status: 'open' | 'closed';
  /** Process that is running this broadcast now; both are removed when it exits. */
  pid?: number;
  startTime?: string;
  targets: BroadcastTarget[];
}
