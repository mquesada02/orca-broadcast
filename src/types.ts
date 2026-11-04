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
  /** `mainAgent.state` of the worktree ps row. Omitted when Orca sends no `mainAgent` (it is undocumented). */
  mainAgentState?: string;
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
  dispatchId?: string;
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

export type StartFailure = 'invalid-session-id' | 'flag-not-allowed' | 'no-transcript' | 'start-failed';

// `message` is the error text of a `start-failed`.
export type StartResult = { started: true; handle: string } | { started: false; reason: StartFailure; message?: string };

// A live `claude` process of the current user whose session ID is known. `startTime` is field 22 of the process's `stat` file (clock ticks since boot).
export interface SessionRecord {
  sessionId: string;
  paneKey: string | null;
  cwd: string | null;
  permission: string | null;
  startTime: number;
}

export interface SessionScan {
  sessions: SessionRecord[];
  // `claude` processes whose session ID could not be determined (cwd null when unknown).
  unknown: { cwd: string | null }[];
  // Session IDs that another process of the user holds with `--resume <id>` or `-r <id>` (for example a shell about to start `claude`).
  heldByOthers: string[];
}

// One live Claude agent in a roster snapshot. It never holds prompt, reply or environment content.
export interface RosterEntry {
  sessionId: string;
  paneKey: string;
  repo: string;
  repoId: string;
  worktree: string;
  worktreeId: string;
  worktreePath: string;
  role: Role;
  orchestrationRunIds: string[];
  state: 'working' | 'done' | 'waiting';
  stateStartedAt: number;
  /** ISO time of the save that wrote this entry. */
  savedAt: string;
  /** A worker only: the session ID of its coordinator, when it can be resolved. */
  coordinatorSessionId?: string;
  /** A worker only: the dispatch ID of its worker-list row, when it has one. */
  dispatchId?: string;
  /** The permission flag of the process, when known. */
  permission?: string;
}

// The roster of one runtime: the pair (boot ID, Orca runtime ID). Times are ISO text.
export interface RosterSnapshot {
  bootId: string;
  runtimeId: string | null;
  firstSavedAt: string;
  lastSavedAt: string;
  entries: RosterEntry[];
}

export interface OrcaPort {
  listAgents(): Promise<AgentRow[]>;
  // The same `worktree ps` as listAgents, with the runtime ID of its `_meta` (null when absent).
  listAgentsWithRuntime(): Promise<{ rows: AgentRow[]; runtimeId: string | null }>;
  scanSessions(): Promise<SessionScan>;
  bootId(): Promise<string>;
  startAgent(worktreePath: string, sessionId: string, permission: string | null, title: string): Promise<StartResult>;
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
export type PauseReason = 'still-working' | 'background' | 'waiting-permission' | 'done-no-token' | 'send-failed' | 're-woken' | 'self';
export type ResumeStatus = 'pending' | 'resumed' | 'gone' | 'abandoned';
// Why an agent cannot be located any more.
export type LocateReason = 'terminal-closed' | 'terminal-orphaned' | 'agent-missing' | 'agent-exited';
export type ResumeReason =
  | LocateReason
  | 'waiting-permission'
  | 'send-failed'
  | 'no-proof'
  | 'queued-while-working'
  | 'self';

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
  broadcastSelf?: BroadcastSelf | null;
  /** How many targets `close` abandoned in a broadcast. */
  abandoned?: number;
  /** Lines printed on stderr in text mode (never in `--json`): recovery notes and the broadcast a pause abandoned. */
  warnings?: string[];
}

// This session on the self line: the saved status when it is a recorded target of the open broadcast.
export interface BroadcastSelf extends ConfirmTarget {
  status?: BroadcastStatus;
  reason?: BroadcastReason | null;
}

// The live states a broadcast can select.
export type AgentState = 'working' | 'done';

// What the user typed for each filter kind, as stored for display.
export interface FilterSpec {
  repo: string[];
  worktree: string[];
  role: Role[];
  run: string[];
  /** Only `broadcast` and its groups use it; the kinds above are the ones every command knows. */
  state?: AgentState[];
}

// One resolved filter set: a kind that is absent does not filter. A set with no kind matches every agent.
export interface FilterSet {
  repoIds?: string[];
  worktreeIds?: string[];
  roles?: Role[];
  runIds?: string[];
  /** The live states a broadcast selects (`--state`). */
  states?: AgentState[];
  typed: Partial<FilterSpec>;
  /** The saved group this set came from, for display only. */
  group?: string;
  /** A union of groups: the set matches an agent when any of these sets does. It then holds no kind of its own. */
  anyOf?: FilterSet[];
}

// A saved group as a command uses it: its name and its filters, without the `state` kind that pause, resume and close skip.
export interface GroupFilter {
  name: string;
  spec: FilterSpec;
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
export type BroadcastReason = LocateReason | 'waiting-permission' | 'still-working' | 'background' | 'no-ack' | 'send-failed' | 'closed' | 'paused';

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
