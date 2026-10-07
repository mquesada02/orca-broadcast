import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordStore } from '../../src/store.js';
import type { AgentRecord, AgentRow, Clock, OrcaPort, RepoRow, Run, RunRow, SendResult, TerminalRow, WorkerRow } from '../../src/types.js';

export interface Reply {
  state: string;
  message: string | null;
}

export interface Behavior {
  (ctx: { listCalls: number; received: string[] }): Reply;
}

export interface FakeAgent {
  paneKey: string;
  agentType?: string;
  worktree?: string;
  repo?: string;
  /** The pane of the agent that started this one (the parent link of worktree ps). */
  parentPaneKey?: string | null;
  stateStartedAt?: number;
  hasTerminal?: boolean;
  agentIdentity?: string | null;
  orphaned?: boolean;
  hasRow?: boolean;
  /** Terminal shape at a listing number (overrides the static fields); one listing = one worktree ps + terminal list pair, poll or pre-send read. */
  terminalAt?: (listing: number) => 'missing' | 'orphaned' | 'not-claude' | 'ok';
  /** Whether the worktree ps row exists at a listing number (also needs hasRow). */
  rowAt?: (listing: number) => boolean;
  behavior: Behavior;
}

export class FakeOrca implements OrcaPort {
  sends: { handle: string; text: string }[] = [];
  listCalls = 0;
  listTerminalsCalls = 0;
  listRunsCalls = 0;
  listWorkersCalls = 0;
  /** Pane keys with an active worker row (run id optional), by worker-list call number. */
  workersAt: (workerListCall: number) => { paneKey: string; runId?: string | null }[] = () => [];
  /** Raw run-list rows by call number (a null or unknown handle is a stale one); used instead of coordinatorsAt when set. */
  runsAt: ((runListCall: number) => RunRow[]) | null = null;
  /** Make every worker-list call from this number on throw. */
  failWorkerListsFrom: number | null = null;
  /** Pane keys whose terminal is a run's coordinator, by run-list call number (not the worktree ps listing number). */
  coordinatorsAt: (runListCall: number) => string[] = () => [];
  /** Make the run-list call with this number throw (one transient failure, which the retry path survives). */
  failRunListAt: number | null = null;
  /** Make every run-list call from this number on throw (a failure that outlasts the retries). */
  failRunListsFrom: number | null = null;
  sendResult: (handle: string, attempt: number) => SendResult = () => ({ accepted: true });
  listError: Error | null = null;
  /** Make the listing with this number throw (a pair counts once, on its worktree ps call). */
  failListingAt: number | null = null;
  /** Make every listing from this number on throw (a persistent failure that survives retries). */
  failListingsFrom: number | null = null;
  /** Make the next n worktree ps calls throw (each retry attempt counts once). */
  listFailures = 0;
  extraRows: AgentRow[] = [];
  onSend: () => Promise<void> | void = () => {};
  private received = new Map<string, string[]>();

  constructor(public agents: FakeAgent[]) {}

  private terminalOf(agent: FakeAgent): TerminalRow | null {
    const mode = agent.terminalAt?.(this.listCalls);
    if (mode === 'missing' || (!mode && agent.hasTerminal === false)) return null;
    return {
      handle: this.handleOf(agent.paneKey),
      paneKey: agent.paneKey,
      orphaned: mode ? mode === 'orphaned' : (agent.orphaned ?? false),
      agentIdentity: mode ? (mode === 'not-claude' ? 'codex' : 'claude') : agent.agentIdentity === undefined ? 'claude' : agent.agentIdentity,
    };
  }

  handleOf(paneKey: string): string {
    return `term_${paneKey}`;
  }

  async listAgents(): Promise<AgentRow[]> {
    if (this.listError) throw this.listError;
    this.listCalls += 1;
    if (this.failListingAt === this.listCalls) throw new Error('orca-ide worktree ps failed: boom');
    if (this.failListingsFrom !== null && this.listCalls >= this.failListingsFrom) throw new Error('orca-ide worktree ps failed: down');
    if (this.listFailures > 0) {
      this.listFailures -= 1;
      throw new Error('orca-ide worktree ps failed: transient');
    }
    const rows = this.agents.filter((a) => a.hasRow !== false && (a.rowAt?.(this.listCalls) ?? true)).map((a): AgentRow => {
      const reply = a.behavior({ listCalls: this.listCalls, received: this.received.get(a.paneKey) ?? [] });
      return {
        paneKey: a.paneKey,
        worktreeId: `wt-${a.paneKey}`,
        worktree: a.worktree ?? `tree-${a.paneKey}`,
        repo: a.repo ?? 'repo',
        repoId: `repo-${a.repo ?? 'repo'}`,
        path: `/work/${a.worktree ?? `tree-${a.paneKey}`}`,
        parentPaneKey: a.parentPaneKey ?? null,
        agentType: a.agentType ?? 'claude',
        state: reply.state,
        stateStartedAt: a.stateStartedAt ?? 1,
        lastAssistantMessage: reply.message,
      };
    });
    return [...rows, ...this.extraRows];
  }

  async listTerminals(): Promise<TerminalRow[]> {
    this.listTerminalsCalls += 1;
    return this.agents.flatMap((a) => this.terminalOf(a) ?? []);
  }

  async listRuns(): Promise<RunRow[]> {
    this.listRunsCalls += 1;
    if (this.failRunListAt === this.listRunsCalls || (this.failRunListsFrom !== null && this.listRunsCalls >= this.failRunListsFrom)) throw new Error('orca-ide orchestration run-list failed: boom');
    if (this.runsAt) return this.runsAt(this.listRunsCalls);
    return this.coordinatorsAt(this.listRunsCalls).map((paneKey, i) => ({ id: `run_${i}`, coordinatorHandle: this.handleOf(paneKey) }));
  }

  async listWorkers(): Promise<WorkerRow[]> {
    this.listWorkersCalls += 1;
    if (this.failWorkerListsFrom !== null && this.listWorkersCalls >= this.failWorkerListsFrom) throw new Error('orca-ide orchestration worker-list failed: boom');
    return this.workersAt(this.listWorkersCalls).map((w) => ({ handle: this.handleOf(w.paneKey), runId: w.runId ?? null }));
  }

  async listRepos(): Promise<RepoRow[]> {
    return [];
  }

  async send(handle: string, text: string): Promise<SendResult> {
    await this.onSend();
    const target = this.agents.find((x) => this.handleOf(x.paneKey) === handle);
    const terminal = target ? this.terminalOf(target) : null;
    if (!terminal || terminal.orphaned || terminal.agentIdentity !== 'claude') {
      throw new Error(`fake orca: send to a missing, orphaned or non-Claude terminal (${handle}); the CLI must never type there`);
    }
    this.sends.push({ handle, text });
    const result = this.sendResult(handle, this.sends.filter((s) => s.handle === handle).length);
    if (result.accepted) {
      const agent = this.agents.find((a) => this.handleOf(a.paneKey) === handle);
      if (agent) this.received.set(agent.paneKey, [...(this.received.get(agent.paneKey) ?? []), text]);
    }
    return result;
  }

  sendsTo(paneKey: string): number {
    return this.sends.filter((s) => s.handle === this.handleOf(paneKey)).length;
  }
}

export function tokenOf(text: string): string {
  return /ORCA-PAUSED ([0-9a-z]+)\./.exec(text)?.[1] ?? 'no-token';
}

export const CONTINUE_PREFIX = '[orca-broadcast] CONTINUE';

const gotContinue = (received: string[]) => received.some((t) => t.startsWith(CONTINUE_PREFIX));

export const PAUSED_REPLY = 'Stopped here.\nORCA-PAUSED abcd1234';

export const pausedDone = (note = PAUSED_REPLY): Behavior => () => ({ state: 'done', message: note });

export const startsNewTurnAfterContinue: Behavior = ({ received }) =>
  gotContinue(received) ? { state: 'done', message: 'Continued and finished.' } : { state: 'done', message: PAUSED_REPLY };

export const working: Behavior = () => ({ state: 'working', message: null });

/** An agent that a background task woke after its token reply: working, with a newer reply that has no token line. */
export const wokenWorking: Behavior = () => ({ state: 'working', message: 'Back at work.' });

/** A finished reply whose last line is the pause token from the first message received. */
export const doneWithToken = (received: string[], note = 'Stopped here. Next: run tests.'): Reply => ({
  state: 'done',
  message: `${note}\nORCA-PAUSED ${tokenOf(received[0] as string)}`,
});

export const repliesWithToken =
  (note?: string): Behavior =>
  ({ received }) =>
    received.length === 0 ? { state: 'working', message: null } : doneWithToken(received, note);

export const fakeClock = (start = 1_000_000): Clock & { slept: number; onSleep: () => void } => {
  const clock = {
    slept: 0,
    onSleep: () => {},
    now: () => start + clock.slept,
    sleep: async (ms: number) => {
      clock.slept += ms;
      clock.onSleep();
    },
  };
  return clock;
};

export const tempStateDir = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'orca-broadcast-test-')), 'state');

/** Replies with the token `delay` listings after it received the pause message. */
export const repliesAfter = (delay: number): Behavior => {
  let seen = 0;
  return ({ received }) => {
    if (received.length === 0) return { state: 'working', message: null };
    seen += 1;
    return seen > delay ? doneWithToken(received, 'Stopped.') : { state: 'working', message: null };
  };
};

export function agentRecord(paneKey: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    paneKey,
    worktreeId: `wt-${paneKey}`,
    worktree: `tree-${paneKey}`,
    repo: 'repo',
    role: 'worker',
    orchestrationRunIds: [],
    lastHandle: null,
    pauseStatus: 'confirmed',
    pauseReason: null,
    pauseBaseline: null,
    messagePending: false,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    wakeCount: 0,
    resumeStatus: 'pending',
    ...extra,
  };
}

export async function seedOpenRun(store: RecordStore, agents: AgentRecord[], extra: Partial<Run> = {}): Promise<Run> {
  const run: Run = { runId: 'run-1', token: 'abcd1234', startedAt: '2026-01-01T00:00:00.000Z', status: 'open', agents, ...extra };
  await store.save(run);
  await store.setCurrent('pause', run.runId);
  return run;
}
