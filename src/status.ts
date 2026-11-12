import { isFinalRow } from './recover-record.js';
import type { OpenWinner } from './store.js';
import type { AgentRecord, RunRecoveryRow } from './types.js';

/** One line of the table of `status`: the fields of a broadcast target or a recovery row, as the record holds them. */
export interface StatusRow {
  repo: string;
  worktree: string;
  role: string;
  status: string;
  reason: string | null;
}

export interface StatusCounts {
  done: number;
  pending: number;
  total: number;
}

/** What `status` shows about the one open run; both the text and the JSON are made from it. */
export interface StatusView {
  kind: 'broadcast' | 'recovery' | 'pause';
  id: string;
  /** The command that started the run, or (a pause run) the command of its phase. */
  command: 'broadcast' | 'recover' | 'pause' | 'resume';
  running: boolean;
  /** The save stamp as stored; null when the record has none or it is not a date. */
  savedAt: string | null;
  /** How old the save is, as the header prints it; null with no `savedAt`. */
  age: string | null;
  phase: 'pause' | 'resume' | null;
  /** The word the count line uses for a finished row. */
  doneWord: string;
  nextStep: string;
  counts: StatusCounts;
  rows: StatusRow[];
  /** A pause run only: the rows of its latest `recover`, as a second section; null when the run holds none. */
  latestRecover: StatusSection | null;
}

/** The rows of one section of `status` with their counts. */
export interface StatusSection {
  counts: StatusCounts;
  rows: StatusRow[];
}

const KIND_WORD = { broadcast: 'broadcast', recovery: 'recovery', pause: 'pause run' } as const;

// A plain comparison, not `localeCompare`: the order must not depend on the locale of the process.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pending rows first, then the rest; each group by repo, worktree, role. Rows equal on all three keys keep their order. */
export function sortRows(rows: { row: StatusRow; pending: boolean }[]): StatusRow[] {
  return [...rows]
    .sort((a, b) => Number(b.pending) - Number(a.pending) || compare(a.row.repo, b.row.repo) || compare(a.row.worktree, b.row.worktree) || compare(a.row.role, b.row.role))
    .map(({ row }) => row);
}

export function countsOf(total: number, pending: number): StatusCounts {
  return { done: total - pending, pending, total };
}

/** The save stamp when it is a date, else null. */
const validStamp = (savedAt: string | null): string | null => (savedAt !== null && !Number.isNaN(Date.parse(savedAt)) ? savedAt : null);

/** The age of a save: whole seconds, `<n>s` under a minute, else `m:ss`; a stamp later than the clock counts as 0. */
export function formatAge(savedAt: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(savedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Copies only these five fields, so the JSON never holds another field of a target or a row.
const pick = (r: StatusRow): StatusRow => ({ repo: r.repo, worktree: r.worktree, role: r.role, status: r.status, reason: r.reason });

function rowsOf(winner: Exclude<OpenWinner, { kind: 'pause' }>): { rows: { row: StatusRow; pending: boolean }[]; doneWord: string } {
  if (winner.kind === 'broadcast') return { doneWord: 'acked', rows: winner.record.targets.map((t) => ({ row: pick(t), pending: t.status === 'pending' })) };
  const { rows } = winner.record;
  return { doneWord: 'final', rows: rows.map((r) => ({ row: pick(r), pending: !isFinalRow(r, rows) })) };
}

/**
 * A pause-phase agent is pending when `pause` still waits for it: it is not confirmed, and it is not settled by the pause code (`isSettled`:
 * gone, or `send-failed`) or left out of the pause count (the running session's own agent, marked `self`).
 */
const isPausePending = (a: AgentRecord): boolean => a.pauseStatus === 'unconfirmed' && a.pauseReason !== 'send-failed' && a.pauseReason !== 'self' && a.resumeStatus !== 'gone';

const sectionOf = (shown: { row: StatusRow; pending: boolean }[]): StatusSection => ({ counts: countsOf(shown.length, shown.filter((r) => r.pending).length), rows: sortRows(shown) });

function buildPauseStatus(winner: Extract<OpenWinner, { kind: 'pause' }>, common: { running: boolean; savedAt: string | null; age: string | null }): StatusView {
  const { agents, recovery, runId } = winner.record;
  // The resume phase starts once any agent has a CONTINUE send time on disk.
  const resume = agents.some((a) => a.continueSentAt !== undefined);
  const shown = agents.map((a) =>
    resume
      ? { row: pick({ repo: a.repo, worktree: a.worktree, role: a.role, status: a.resumeStatus, reason: a.resumeReason ?? null }), pending: a.resumeStatus === 'pending' }
      : { row: pick({ repo: a.repo, worktree: a.worktree, role: a.role, status: a.pauseStatus, reason: a.pauseReason }), pending: isPausePending(a) },
  );
  const { counts, rows } = sectionOf(shown);
  const latestRecover = recovery ? sectionOf(recovery.rows.map((r) => ({ row: pick(r), pending: !isFinalRow(r, recovery.rows) }))) : null;
  return {
    ...common,
    kind: 'pause',
    id: runId,
    command: resume ? 'resume' : 'pause',
    phase: resume ? 'resume' : 'pause',
    doneWord: resume ? 'resumed' : 'confirmed',
    nextStep: resume ? 're-run resume to continue' : 'run pause again or resume to continue',
    counts,
    rows,
    latestRecover,
  };
}

export function buildStatus(winner: OpenWinner, running: boolean, nowMs: number): StatusView {
  const savedAt = validStamp(winner.savedAt);
  const common = { running, savedAt, age: savedAt === null ? null : formatAge(savedAt, nowMs) };
  if (winner.kind === 'pause') return buildPauseStatus(winner, common);
  const shown = rowsOf(winner);
  const pending = shown.rows.filter((r) => r.pending).length;
  const isBroadcast = winner.kind === 'broadcast';
  return {
    ...common,
    kind: winner.kind,
    id: winner.record.id,
    command: isBroadcast ? 'broadcast' : 'recover',
    phase: null,
    doneWord: shown.doneWord,
    nextStep: isBroadcast ? 're-run broadcast to continue' : 're-run recover to continue',
    counts: countsOf(shown.rows.length, pending),
    rows: sortRows(shown.rows),
    latestRecover: null,
  };
}

function formatRows(rows: StatusRow[]): string[] {
  const cells = rows.map((r) => [`${r.repo}/${r.worktree}`, r.role, r.status, r.reason ?? '']);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...cells.map((c) => c[i]!.length)));
  return cells.map((c) => `  ${c.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()}`);
}

export function renderStatus(view: StatusView | null): string {
  if (view === null) return 'no open run\n';
  const age = view.savedAt === null ? '' : ` · saved ${view.age} ago`;
  const header = `${KIND_WORD[view.kind]} ${view.id} · ${view.running ? 'running' : `not running: ${view.nextStep}`}${age}`;
  const countLine = ({ done, total, pending }: StatusCounts, word: string): string => `${done}/${total} ${word}, ${pending} pending`;
  const lines = [header, ...formatRows(view.rows), countLine(view.counts, view.doneWord)];
  if (view.latestRecover) lines.push('', 'latest recover', ...formatRows(view.latestRecover.rows), countLine(view.latestRecover.counts, 'final'));
  return `${lines.join('\n')}\n`;
}

export function statusJson(view: StatusView | null): string {
  if (view === null) return `${JSON.stringify({ command: 'status', open: null })}\n`;
  const { kind, id, command, running, savedAt, phase, counts, rows, latestRecover } = view;
  return `${JSON.stringify({ command: 'status', open: { kind, id, command, running, savedAt, phase, counts, rows, latestRecover } })}\n`;
}
