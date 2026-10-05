import { execFile } from 'node:child_process';
import type { AgentRow, OrcaPort, RunRow, SendResult, TerminalRow } from './types.js';

export const ORCA_EXECUTABLE = 'orca-ide';

export interface ExecResult {
  stdout: string;
  code: number;
}

export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export const execOrca: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, stdout) => {
      if (!error) return resolve({ stdout, code: 0 });
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      if (typeof code === 'number') return resolve({ stdout, code });
      reject(error);
    });
  });

interface Envelope {
  ok: boolean;
  result?: Record<string, any>;
  error?: { code?: string; message?: string };
}

function parseEnvelope(stdout: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('orca-ide returned invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Envelope).ok !== 'boolean') {
    throw new Error('orca-ide returned an unexpected JSON shape');
  }
  return parsed as Envelope;
}

export function createOrcaAdapter(exec: Exec = execOrca): OrcaPort {
  async function call(args: string[]): Promise<Record<string, any>> {
    const { stdout } = await exec(ORCA_EXECUTABLE, args);
    const envelope = parseEnvelope(stdout);
    if (!envelope.ok) {
      throw new Error(`orca-ide ${args.slice(0, 2).join(' ')} failed: ${envelope.error?.message ?? 'unknown error'}`);
    }
    return envelope.result ?? {};
  }

  function assertComplete(label: string, result: Record<string, any>): void {
    const omitted: unknown[] = result.hostScope?.omittedHostIds ?? [];
    if (result.truncated === true || omitted.includes('local')) {
      throw new Error(`orca-ide ${label} listing is incomplete (truncated or local host omitted)`);
    }
  }

  return {
    async listAgents() {
      const result = await call(['worktree', 'ps', '--json']);
      assertComplete('worktree ps', result);
      const rows: AgentRow[] = [];
      for (const worktree of result.worktrees ?? []) {
        for (const agent of worktree.agents ?? []) {
          rows.push({
            paneKey: agent.paneKey,
            worktreeId: worktree.worktreeId,
            worktree: worktree.displayName,
            repo: worktree.repo,
            agentType: agent.agentType,
            state: agent.state,
            stateStartedAt: agent.stateStartedAt,
            lastAssistantMessage: agent.lastAssistantMessage ?? null,
          });
        }
      }
      return rows;
    },

    async listTerminals() {
      const result = await call(['terminal', 'list', '--json']);
      assertComplete('terminal list', result);
      return (result.terminals ?? []).map(
        (t: Record<string, any>): TerminalRow => ({
          handle: t.handle,
          tabId: t.tabId,
          leafId: t.leafId,
          orphaned: t.orphaned === true,
          agentIdentity: t.agentIdentity ?? null,
        }),
      );
    },

    async listRuns() {
      const runs: RunRow[] = [];
      let cursor: string | null = null;
      do {
        const args = ['orchestration', 'run-list', '--json', ...(cursor ? ['--cursor', cursor] : [])];
        const result = await call(args);
        for (const run of result.runs ?? []) {
          runs.push({ id: run.id, coordinatorHandle: run.coordinator_handle });
        }
        cursor = result.nextCursor ?? null;
      } while (cursor);
      return runs;
    },

    async send(handle, text): Promise<SendResult> {
      try {
        const { stdout } = await exec(ORCA_EXECUTABLE, ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json']);
        const envelope = parseEnvelope(stdout);
        if (!envelope.ok) return { accepted: false, reason: envelope.error?.code ?? 'send-rejected' };
        return envelope.result?.accepted === true ? { accepted: true } : { accepted: false, reason: 'not-accepted' };
      } catch (error) {
        return { accepted: false, reason: (error as Error).message };
      }
    },
  };
}
