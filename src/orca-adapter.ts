import { execFile } from 'node:child_process';
import { access, readdir, readFile, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { parseProcStartTime } from './store.js';
import { readTranscript, transcriptPath } from './transcript.js';
import type { AgentRow, OrcaPort, RepoRow, RunRow, SendResult, SessionRecord, SessionScan, StartResult, TerminalRow, WorkerRow, WorktreeRow } from './types.js';

export const ORCA_EXECUTABLE = 'orca-ide';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class ExecFailure extends Error {
  constructor(
    cause: Error,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(cause.message, { cause });
  }
}

export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const WORKTREE_LIST_LIMIT = 10_000;

export const execOrca: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr, code: 0 });
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      if (typeof code === 'number') return resolve({ stdout, stderr, code });
      reject(new ExecFailure(error, stdout, stderr));
    });
  });

interface Envelope {
  ok: boolean;
  result?: Record<string, any>;
  error?: { code?: string; message?: string };
  _meta?: { runtimeId?: unknown };
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

const REQUEST_ID = /"orchestrationRequestId"\s*:\s*"([\w-]+)"|--retry-request\s+([\w-]+)/;

function findRequestId(output: string): string | null {
  const match = REQUEST_ID.exec(output);
  return match?.[1] ?? match?.[2] ?? null;
}

// A send is "unknown" when Orca printed no valid JSON envelope: it may or may not have delivered the text.
type SendAttempt = { kind: 'known'; result: SendResult } | { kind: 'unknown'; reason: string; output: string };

async function attemptSend(exec: Exec, args: string[]): Promise<SendAttempt> {
  let output = '';
  try {
    const { stdout, stderr } = await exec(ORCA_EXECUTABLE, args);
    output = `${stdout}\n${stderr}`;
    const envelope = parseEnvelope(stdout);
    if (!envelope.ok) return { kind: 'known', result: { accepted: false, reason: envelope.error?.code ?? 'send-rejected' } };
    return { kind: 'known', result: envelope.result?.send?.accepted === true ? { accepted: true } : { accepted: false, reason: 'not-accepted' } };
  } catch (error) {
    if (error instanceof ExecFailure) output = `${error.stdout}\n${error.stderr}`;
    return { kind: 'unknown', reason: (error as Error).message, output };
  }
}

// Where the adapter reads the machine: injectable so that no test scans the real machine.
export interface AdapterOptions {
  /** The `/proc` root. Default `/proc`. */
  procRoot?: string;
  /** The Claude Code folder. Default `~/.claude`. */
  claudeDir?: string;
  /** The user whose processes the scan counts. Default `process.getuid()`. */
  uid?: number;
  /** Clock ticks per second. Default 100. Not read yet: the captured `sessions/<pid>.json` holds its start time in ticks, which needs no conversion. */
  clockTick?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BYPASS_MODE = '--permission-mode bypassPermissions';
const PERMISSION_FLAGS = [BYPASS_MODE, '--dangerously-skip-permissions'];

type Read = { kind: 'ok'; data: string } | { kind: 'gone' } | { kind: 'unreadable' };

// ENOENT means the process ended (or the file is missing); any other error is "cannot read" and is handled in the safe direction.
async function readText(path: string): Promise<Read> {
  try {
    return { kind: 'ok', data: await readFile(path, 'utf8') };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'gone' } : { kind: 'unreadable' };
  }
}

function resumeIds(args: string[]): string[] {
  const ids: string[] = [];
  args.forEach((arg, i) => {
    const next = args[i + 1];
    if ((arg === '--resume' || arg === '-r') && next !== undefined && UUID.test(next)) ids.push(next);
  });
  return ids;
}

// The earliest recognised permission flag; `--permission-mode` with another value, or with no value, is no flag.
function permissionOf(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dangerously-skip-permissions') return arg;
    if (arg === '--permission-mode=bypassPermissions' || (arg === '--permission-mode' && args[i + 1] === 'bypassPermissions')) return BYPASS_MODE;
  }
  return null;
}

// The value of the first `<name>=` entry of a process environment, or null when it is unset.
function envVar(environ: string, name: string): string | null {
  const prefix = `${name}=`;
  const entry = environ.split('\0').find((candidate) => candidate.startsWith(prefix));
  return entry === undefined ? null : entry.slice(prefix.length);
}

function paneKeyOf(environ: string): string | null {
  return envVar(environ, 'ORCA_PANE_KEY') || null;
}

// Claude Code's own record of the session of one process; trusted only when its start time is the live process's (the file can outlive a crash and the pid can be reused).
async function sessionFromFile(configDir: string, pid: string, liveStartTime: string): Promise<{ sessionId: string; cwd: string | null } | null> {
  const file = await readText(join(configDir, 'sessions', `${pid}.json`));
  if (file.kind !== 'ok') return null;
  try {
    const parsed: unknown = JSON.parse(file.data);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { sessionId, procStart, cwd } = parsed as { sessionId?: unknown; procStart?: unknown; cwd?: unknown };
    if (typeof sessionId !== 'string' || sessionId === '' || String(procStart) !== liveStartTime) return null;
    return { sessionId, cwd: typeof cwd === 'string' && cwd !== '' ? cwd : null };
  } catch {
    return null;
  }
}

// The config dir of one process: its `CLAUDE_CONFIG_DIR` when that is an absolute path, else the adapter's option.
function configDirOf(environ: string, fallback: string): string {
  const value = envVar(environ, 'CLAUDE_CONFIG_DIR');
  return value !== null && isAbsolute(value) ? value : fallback;
}

export function createOrcaAdapter(exec: Exec = execOrca, options: AdapterOptions = {}): OrcaPort {
  const procRoot = options.procRoot ?? '/proc';
  const claudeDir = options.claudeDir ?? join(homedir(), '.claude');
  const uid = () => options.uid ?? process.getuid!();

  async function callWithMeta(args: string[]): Promise<{ result: Record<string, any>; meta: Envelope['_meta'] }> {
    const { stdout } = await exec(ORCA_EXECUTABLE, args);
    const envelope = parseEnvelope(stdout);
    if (!envelope.ok) {
      throw new Error(`orca-ide ${args.slice(0, 2).join(' ')} failed: ${envelope.error?.message ?? 'unknown error'}`);
    }
    return { result: envelope.result ?? {}, meta: envelope._meta };
  }

  async function call(args: string[]): Promise<Record<string, any>> {
    return (await callWithMeta(args)).result;
  }

  async function readAgents(): Promise<{ rows: AgentRow[]; runtimeId: string | null }> {
    const { result, meta } = await callWithMeta(['worktree', 'ps', '--json']);
    assertComplete('worktree ps', result);
    const rows: AgentRow[] = [];
    for (const worktree of result.worktrees ?? []) {
      for (const agent of worktree.agents ?? []) {
        rows.push({
          paneKey: agent.paneKey,
          parentPaneKey: agent.parentPaneKey ?? null,
          worktreeId: worktree.worktreeId,
          worktree: worktree.displayName,
          repoId: worktree.repoId,
          path: worktree.path,
          repo: worktree.repo,
          agentType: agent.agentType,
          state: agent.state,
          stateStartedAt: agent.stateStartedAt,
          lastAssistantMessage: agent.lastAssistantMessage ?? null,
          ...(typeof agent.mainAgent?.state === 'string' ? { mainAgentState: agent.mainAgent.state } : {}),
        });
      }
    }
    return { rows, runtimeId: typeof meta?.runtimeId === 'string' ? meta.runtimeId : null };
  }

  async function bootId(): Promise<string> {
    return (await readFile(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim();
  }

  // Reads run in this order: status, cmdline, stat, environ, cwd. The first ENOENT ignores the process; an unreadable
  // cmdline ends its reads with an unknown entry (cwd null); an unreadable stat gives an unknown entry with its cwd.
  async function scanSessions(): Promise<SessionScan> {
    // The result is not used: an unreadable boot ID fails the scan, so a caller never works from a scan of an unknown boot.
    await bootId();
    const sessions: SessionRecord[] = [];
    const unknown: SessionScan['unknown'] = [];
    const held = new Set<string>();
    const me = uid();
    const pids = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name));
    for (const pid of pids) {
      const dir = join(procRoot, pid);
      const status = await readText(join(dir, 'status'));
      if (status.kind === 'gone') continue;
      const owner = status.kind === 'ok' ? /^Uid:\s+(\d+)/m.exec(status.data)?.[1] : undefined;
      if (owner !== undefined && Number(owner) !== me) continue;

      const cmdline = await readText(join(dir, 'cmdline'));
      if (cmdline.kind === 'gone') continue;
      if (cmdline.kind === 'unreadable') {
        unknown.push({ cwd: null });
        continue;
      }
      const args = cmdline.data.split('\0').filter((arg) => arg !== '');
      if (args[0] === undefined || basename(args[0]) !== 'claude') {
        for (const id of resumeIds(args)) held.add(id);
        continue;
      }

      const stat = await readText(join(dir, 'stat'));
      if (stat.kind === 'gone') continue;
      const startToken = stat.kind === 'ok' ? parseProcStartTime(stat.data) : undefined;
      let paneKey: string | null = null;
      let configDir = claudeDir;
      if (startToken !== undefined) {
        const environ = await readText(join(dir, 'environ'));
        if (environ.kind === 'gone') continue;
        if (environ.kind === 'ok') {
          paneKey = paneKeyOf(environ.data);
          configDir = configDirOf(environ.data, claudeDir);
        }
      }
      let cwd: string | null;
      try {
        cwd = await readlink(join(dir, 'cwd'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        cwd = null;
      }

      const fromFile = startToken === undefined ? null : await sessionFromFile(configDir, pid, startToken);
      const sessionId = startToken === undefined ? null : (fromFile?.sessionId ?? resumeIds(args)[0] ?? null);
      if (startToken === undefined || sessionId === null) {
        unknown.push({ cwd });
        continue;
      }
      const startTime = Number(startToken);
      const transcript = fromFile?.cwd ? { transcript: { sessionId, cwd: fromFile.cwd, configDir, pid: Number(pid), startTime } } : {};
      sessions.push({ sessionId, paneKey, cwd, permission: permissionOf(args), startTime, ...transcript });
    }
    return { sessions, unknown, heldByOthers: [...held] };
  }

  async function startAgent(worktreePath: string, sessionId: string, permission: string | null, title: string): Promise<StartResult> {
    if (!UUID.test(sessionId)) return { started: false, reason: 'invalid-session-id' };
    if (permission !== null && !PERMISSION_FLAGS.includes(permission)) return { started: false, reason: 'flag-not-allowed' };
    // Only a transcript that is shown to exist passes: `claude --resume` in a folder with no transcript starts nothing useful.
    try {
      await access(transcriptPath(claudeDir, worktreePath, sessionId));
    } catch {
      return { started: false, reason: 'no-transcript' };
    }
    // Typed into a shell by Orca: safe because the session ID is a checked UUID and the flag is one of the two allowed strings.
    const command = `env -u CLAUDE_CODE_RESUME_INTERRUPTED_TURN claude --resume ${sessionId}${permission === null ? '' : ` ${permission}`}`;
    const failed = (message: string): StartResult => ({ started: false, reason: 'start-failed', message });
    try {
      const { stdout, stderr, code } = await exec(ORCA_EXECUTABLE, ['terminal', 'create', '--worktree', `path:${worktreePath}`, '--title', title, '--command', command, '--json']);
      if (code !== 0) return failed(`orca-ide terminal create exited with code ${code}: ${(stderr || stdout).trim()}`);
      const envelope = parseEnvelope(stdout);
      if (!envelope.ok) return failed(envelope.error?.message ?? 'orca-ide terminal create failed');
      const handle: unknown = envelope.result?.terminal?.handle;
      return typeof handle === 'string' && handle !== '' ? { started: true, handle } : failed('no handle in the receipt');
    } catch (error) {
      return failed((error as Error).message);
    }
  }

  function assertComplete(label: string, result: Record<string, any>): void {
    const omitted: unknown[] = result.hostScope?.omittedHostIds ?? [];
    if (result.truncated === true) {
      throw new Error(`orca-ide ${label} listing is incomplete: Orca reports it as truncated`);
    }
    if (omitted.includes('local')) {
      throw new Error(
        `orca-ide ${label} listing is incomplete: Orca reports the local host as omitted. Restart Orca and run the command again. Restarting Orca fixed this on 2026-10-12.`,
      );
    }
  }

  return {
    async listAgents() {
      return (await readAgents()).rows;
    },

    listAgentsWithRuntime: readAgents,

    scanSessions,

    bootId,

    startAgent,

    readTranscript,

    async listTerminals() {
      const result = await call(['terminal', 'list', '--json']);
      assertComplete('terminal list', result);
      return (result.terminals ?? []).map(
        (t: Record<string, any>): TerminalRow => ({
          handle: t.handle,
          paneKey: `${t.tabId}:${t.leafId}`,
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
          runs.push({ id: run.id, coordinatorHandle: run.coordinator_handle ?? null });
        }
        cursor = result.nextCursor ?? null;
      } while (cursor);
      return runs;
    },

    async listWorkers() {
      const workers: WorkerRow[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      while (true) {
        const args = ['orchestration', 'worker-list', '--terminal-state', 'active', '--json', ...(cursor ? ['--cursor', cursor] : [])];
        const result = await call(args);
        for (const worker of result.workers ?? []) {
          if (worker.agentTerminalHandle) {
            workers.push({ handle: worker.agentTerminalHandle, runId: worker.runId ?? null, ...(typeof worker.dispatchId === 'string' ? { dispatchId: worker.dispatchId } : {}) });
          }
        }
        if (result.page?.hasMore !== true) return workers;
        const next: unknown = result.page.nextCursor;
        if (typeof next !== 'string' || next === '' || seen.has(next)) throw new Error('orca-ide orchestration worker-list paging is broken (more pages but no new cursor)');
        seen.add(next);
        cursor = next;
      }
    },

    async listRepos() {
      const result = await call(['repo', 'list', '--json']);
      return (result.repos ?? []).map((repo: Record<string, any>): RepoRow => ({ id: repo.id, path: repo.path, displayName: repo.displayName }));
    },

    // The command caps its rows by default and says so with `truncated`; an explicit large limit plus the completeness check
    // means no worktree is dropped silently. Archived worktrees are not nameable.
    async listWorktrees() {
      const result = await call(['worktree', 'list', '--limit', String(WORKTREE_LIST_LIMIT), '--json']);
      assertComplete('worktree list', result);
      return (result.worktrees ?? [])
        .filter((worktree: Record<string, any>) => worktree.isArchived !== true)
        .map((worktree: Record<string, any>): WorktreeRow => ({ id: worktree.id, repoId: worktree.repoId, path: worktree.path, displayName: worktree.displayName }));
    },

    async send(handle, text): Promise<SendResult> {
      const args = ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json'];
      const first = await attemptSend(exec, args);
      if (first.kind === 'known') return first.result;
      const requestId = findRequestId(first.output);
      if (!requestId) return { accepted: false, reason: first.reason };
      const retry = await attemptSend(exec, [...args, '--retry-request', requestId]);
      return retry.kind === 'known' ? retry.result : { accepted: false, reason: retry.reason };
    },
  };
}
