import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRow, Clock, OrcaPort, RunRow, SendResult, TerminalRow } from '../../src/types.js';

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
  stateStartedAt?: number;
  hasTerminal?: boolean;
  agentIdentity?: string | null;
  orphaned?: boolean;
  hasRow?: boolean;
  behavior: Behavior;
}

export class FakeOrca implements OrcaPort {
  sends: { handle: string; text: string }[] = [];
  listCalls = 0;
  sendResult: (handle: string, attempt: number) => SendResult = () => ({ accepted: true });
  listError: Error | null = null;
  extraRows: AgentRow[] = [];
  onSend: () => Promise<void> | void = () => {};
  private received = new Map<string, string[]>();

  constructor(public agents: FakeAgent[]) {}

  handleOf(paneKey: string): string {
    return `term_${paneKey}`;
  }

  async listAgents(): Promise<AgentRow[]> {
    if (this.listError) throw this.listError;
    this.listCalls += 1;
    const rows = this.agents.filter((a) => a.hasRow !== false).map((a): AgentRow => {
      const reply = a.behavior({ listCalls: this.listCalls, received: this.received.get(a.paneKey) ?? [] });
      return {
        paneKey: a.paneKey,
        worktreeId: `wt-${a.paneKey}`,
        worktree: a.worktree ?? `tree-${a.paneKey}`,
        repo: a.repo ?? 'repo',
        agentType: a.agentType ?? 'claude',
        state: reply.state,
        stateStartedAt: a.stateStartedAt ?? 1,
        lastAssistantMessage: reply.message,
      };
    });
    return [...rows, ...this.extraRows];
  }

  async listTerminals(): Promise<TerminalRow[]> {
    return this.agents
      .filter((a) => a.hasTerminal !== false)
      .map((a) => {
        return {
          handle: this.handleOf(a.paneKey),
          paneKey: a.paneKey,
          orphaned: a.orphaned ?? false,
          agentIdentity: a.agentIdentity === undefined ? 'claude' : a.agentIdentity,
        };
      });
  }

  async listRuns(): Promise<RunRow[]> {
    return [];
  }

  async send(handle: string, text: string): Promise<SendResult> {
    await this.onSend();
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

export const CONTINUE_PREFIX = '[orca-pause] CONTINUE';

const gotContinue = (received: string[]) => received.some((t) => t.startsWith(CONTINUE_PREFIX));

export const pausedDone = (note = 'Stopped here.\nORCA-PAUSED abcd1234'): Behavior => () => ({ state: 'done', message: note });

export const startsNewTurnAfterContinue: Behavior = ({ received }) =>
  gotContinue(received) ? { state: 'done', message: 'Continued and finished.' } : { state: 'done', message: 'Stopped here.\nORCA-PAUSED abcd1234' };

export const working: Behavior = () => ({ state: 'working', message: null });

export const repliesWithToken =
  (note = 'Stopped here. Next: run tests.'): Behavior =>
  ({ received }) =>
    received.length === 0
      ? { state: 'working', message: null }
      : { state: 'done', message: `${note}\nORCA-PAUSED ${tokenOf(received[0] as string)}` };

export const fakeClock = (start = 1_000_000): Clock & { slept: number } => {
  const clock = {
    slept: 0,
    now: () => start + clock.slept,
    sleep: async (ms: number) => {
      clock.slept += ms;
    },
  };
  return clock;
};

export const tempStateDir = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'orca-pause-test-')), 'state');
