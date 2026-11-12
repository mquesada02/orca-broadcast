import { isFinalRow } from './recover-record.js';
import type { OpenWinner } from './store.js';

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
  command: 'broadcast' | 'recover' | 'pause';
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
  latestRecover: null;
  /** True when a table of rows and a count line follow the header (a pause run has none until its own ticket). */
  hasRows: boolean;
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

function rowsOf(winner: Exclude<OpenWinner, { kind: 'pause' }>): { rows: { row: StatusRow; pending: boolean }[]; doneWord: string } {
  // Copies only these five fields, so the JSON never holds another field of a target or a row.
  const pick = (r: StatusRow): StatusRow => ({ repo: r.repo, worktree: r.worktree, role: r.role, status: r.status, reason: r.reason });
  if (winner.kind === 'broadcast') return { doneWord: 'acked', rows: winner.record.targets.map((t) => ({ row: pick(t), pending: t.status === 'pending' })) };
  const { rows } = winner.record;
  return { doneWord: 'final', rows: rows.map((r) => ({ row: pick(r), pending: !isFinalRow(r, rows) })) };
}

export function buildStatus(winner: OpenWinner, running: boolean, nowMs: number): StatusView {
  const savedAt = validStamp(winner.savedAt);
  const common = { running, savedAt, age: savedAt === null ? null : formatAge(savedAt, nowMs), latestRecover: null } as const;
  if (winner.kind === 'pause') {
    // A pause run: the header only, until the pause-run view exists.
    return { ...common, kind: 'pause', id: winner.record.runId, command: 'pause', phase: 'pause', doneWord: 'confirmed', nextStep: 'run pause again or resume to continue', counts: countsOf(0, 0), rows: [], hasRows: false };
  }
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
    hasRows: true,
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
  if (!view.hasRows) return `${header}\n`;
  const { done, total, pending } = view.counts;
  return `${[header, ...formatRows(view.rows), `${done}/${total} ${view.doneWord}, ${pending} pending`].join('\n')}\n`;
}

export function statusJson(view: StatusView | null): string {
  if (view === null) return `${JSON.stringify({ command: 'status', open: null })}\n`;
  const { kind, id, command, running, savedAt, phase, counts, rows, latestRecover } = view;
  return `${JSON.stringify({ command: 'status', open: { kind, id, command, running, savedAt, phase, counts, rows, latestRecover } })}\n`;
}
