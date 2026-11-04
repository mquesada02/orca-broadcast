import { sleepOrAbort } from './abort.js';
import { holdersBySession, livePanes, sessionsByPane } from './roster.js';
import { listFresh, POLL_INTERVAL_MS } from './shared.js';
import type { AgentRow, Clock, OrcaPort, RecoverPlan, RecoverReason, RecoverRow, RecoverStatus, RosterEntry, SessionScan, TerminalRow } from './types.js';

// How an agent of the recovery set stands against the live fleet and the scan.
// `restored`: a live row has its session ID. Else its session is `held` by a live process, `unverifiable` (a process of unknown session may hold it), or `free` (the agent is missing).
export type Standing = 'restored' | 'held' | 'unverifiable' | 'free';

export interface Item {
  entry: RosterEntry;
  standing: Standing;
}

/** A held session is checked again for at most this long (or the time left of `--timeout`). */
export const HELD_RECHECK_MS = 60_000;

// The session IDs that a live row, accepted by `locate`, holds; of two rows with one ID the one with the newer process wins.
const liveSessionIds = (listing: { agents: Map<string, AgentRow>; terminals: Map<string, TerminalRow> }, scan: SessionScan): Set<string> =>
  new Set(holdersBySession(livePanes(listing, sessionsByPane(scan))).keys());

// A working folder is the worktree or a folder under it.
const isWithin = (folder: string, root: string): boolean => folder === root || folder.startsWith(root.endsWith('/') ? root : `${root}/`);

function standingOf(entry: RosterEntry, live: Set<string>, scan: SessionScan): Standing {
  if (live.has(entry.sessionId)) return 'restored';
  if (scan.sessions.some((s) => s.sessionId === entry.sessionId) || scan.heldByOthers.includes(entry.sessionId)) return 'held';
  if (scan.unknown.some((u) => u.cwd === null || isWithin(u.cwd, entry.worktreePath))) return 'unverifiable';
  return 'free';
}

export function classify(entries: RosterEntry[], listing: { agents: Map<string, AgentRow>; terminals: Map<string, TerminalRow> }, scan: SessionScan): Item[] {
  const live = liveSessionIds(listing, scan);
  return entries.map((entry) => ({ entry, standing: standingOf(entry, live, scan) }));
}

export interface RecheckDeps {
  port: OrcaPort;
  clock: Clock;
  signal?: AbortSignal;
  /** The end of the `--timeout` clock. */
  deadline: number;
}

/**
 * The held re-check: one loop for every `held` item. Each 2-second tick takes a listing and a scan and classifies the held items again.
 * It ends when no item is held or its time is over (60 seconds, or the time left of `--timeout`). A failed scan ends it at once.
 * Returns true when a scan failed; items still `held` then stay `held` for the caller.
 */
export async function recheckHeld(items: Item[], { port, clock, signal, deadline }: RecheckDeps): Promise<boolean> {
  const end = Math.min(clock.now() + HELD_RECHECK_MS, deadline);
  while (items.some((item) => item.standing === 'held') && clock.now() < end) {
    await sleepOrAbort(clock, Math.min(POLL_INTERVAL_MS, end - clock.now()), signal);
    const [agents, terminals] = await listFresh({ port, clock, signal });
    let scan: SessionScan;
    try {
      scan = await port.scanSessions();
    } catch {
      return true;
    }
    const live = liveSessionIds({ agents, terminals }, scan);
    for (const item of items) if (item.standing === 'held') item.standing = standingOf(item.entry, live, scan);
  }
  return false;
}

// The order of the table: coordinators first, then the others; each group by repo, worktree, session ID and pane key.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export function tableOrder(items: Item[]): Item[] {
  const rank = (item: Item) => (item.entry.role === 'coordinator' ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || compare(a.entry.repo, b.entry.repo) || compare(a.entry.worktree, b.entry.worktree) || compare(a.entry.sessionId, b.entry.sessionId) || compare(a.entry.paneKey, b.entry.paneKey));
}

interface Row {
  entry: RosterEntry;
  status: RecoverStatus;
  reason: RecoverReason | null;
  /** A missing agent that would be restarted. */
  restart: boolean;
  /** An agent that would get the continue prompt. */
  prompt: boolean;
  /** A missing worker whose coordinator would get its list. */
  leave: boolean;
  /** For a `leave` worker: the row of its coordinator. */
  coordinator?: Row;
}

export interface Classified {
  /** In table order. */
  rows: Row[];
  plan: RecoverPlan;
}

export interface ClassifyContext {
  /** The session ID of the session that runs `recover`, when it is known. */
  selfSessionId: string | null;
  /** Every entry of the pre-restart set, before the self session and the filters were removed. */
  everyone: RosterEntry[];
  /** True when a scan failed in the held re-check: no agent is started in this run. */
  scanFailed: boolean;
}

const isWorker = (entry: RosterEntry): boolean => entry.role === 'worker';

/**
 * Turns the standing of each item into its row, and into what the confirmation lists. An item still `held` is `failed`.
 * A missing non-worker is due a restart; a restored or restarted agent whose last state was `working` or `waiting`, and every
 * coordinator with a linkable missing worker, is due a prompt. A missing worker is never restarted.
 */
export function buildRows(items: Item[], { selfSessionId, everyone, scanFailed }: ClassifyContext): Classified {
  const ordered = tableOrder(items);
  const inSet = new Set(ordered.map(({ entry }) => entry.sessionId));
  const everyoneIds = new Set(everyone.map((entry) => entry.sessionId));
  const rows = new Map<string, Row>();
  const failed = (entry: RosterEntry, reason: RecoverReason): Row => ({ entry, status: 'failed', reason, restart: false, prompt: false, leave: false });

  for (const { entry, standing } of ordered) {
    if (standing === 'free' && isWorker(entry)) continue;
    if (standing === 'held') rows.set(entry.sessionId, failed(entry, scanFailed ? 'scan-failed' : 'session-held'));
    else if (standing === 'unverifiable') rows.set(entry.sessionId, failed(entry, 'unverifiable'));
    else if (standing === 'free' && scanFailed) rows.set(entry.sessionId, failed(entry, 'scan-failed'));
    else rows.set(entry.sessionId, { entry, status: 'restored', reason: null, restart: standing === 'free', prompt: entry.state !== 'done', leave: false });
  }

  // A coordinator can only be a row of the first pass: a missing worker is never restarted, so it cannot receive a list.
  const receivers = new Map(rows);
  // A missing worker: the first reason that applies, in the order of the general spec; else its coordinator would get the list.
  for (const { entry, standing } of ordered) {
    if (standing !== 'free' || !isWorker(entry)) continue;
    const row: Row = { entry, status: 'no-coordinator', reason: null, restart: false, prompt: false, leave: false };
    const id = entry.coordinatorSessionId;
    const coordinator = id === undefined ? undefined : receivers.get(id);
    if (id !== undefined && id === selfSessionId) row.reason = 'coordinator-is-self';
    else if (id !== undefined && everyoneIds.has(id) && !inSet.has(id)) row.reason = 'coordinator-filtered';
    else if (!coordinator || coordinator.status === 'failed') row.reason = 'coordinator-missing';
    else {
      row.status = 'restored';
      row.leave = true;
      row.coordinator = coordinator;
      coordinator.prompt = true;
    }
    rows.set(entry.sessionId, row);
  }

  const all = ordered.map(({ entry }) => rows.get(entry.sessionId) as Row);
  const target = (row: Row) => ({ repo: row.entry.repo, worktree: row.entry.worktree, role: row.entry.role });
  const plan: RecoverPlan = {
    restarts: all.filter((row) => row.restart).map((row) => ({ ...target(row), permission: row.entry.permission ?? null })),
    prompts: all.filter((row) => row.prompt).map(target),
    leaves: all.filter((row) => row.leave).map((row) => ({ repo: row.entry.repo, worktree: row.entry.worktree, coordinator: { repo: (row.coordinator as Row).entry.repo, worktree: (row.coordinator as Row).entry.worktree } })),
  };
  return { rows: all, plan };
}

/** The rows as the table shows them. A row that a restart or a prompt would handle ends `pending` with the given reason (`declined` or `timed-out`). */
export function finalRows(classified: Classified, pendingReason: 'declined' | 'timed-out'): RecoverRow[] {
  return classified.rows.map((row): RecoverRow => {
    const due = row.restart || row.prompt || row.leave;
    const { entry } = row;
    return {
      sessionId: entry.sessionId,
      repo: entry.repo,
      worktree: entry.worktree,
      worktreePath: entry.worktreePath,
      role: entry.role,
      status: due ? 'pending' : row.status,
      reason: due ? pendingReason : row.reason,
      dispatchId: entry.role === 'worker' ? (entry.dispatchId ?? null) : null,
    };
  });
}
