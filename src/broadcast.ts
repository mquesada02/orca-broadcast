import { sleepOrAbort, throwIfAborted } from './abort.js';
import { cancelled, coordinatorsFirst, endsWithLine, failure, hasNewReply, isWaitingLike, iso, listFresh, listSnapshot, locate, POLL_INTERVAL_MS, randomToken, roleInfoOf, type Roles, type Snapshot } from './shared.js';
import type { RecordStore } from './store.js';
import type { AgentRow, BroadcastRecord, BroadcastTarget, Clock, Confirm, ConfirmTarget, OrcaPort, RunSummary, TerminalRow } from './types.js';

export const DEFAULT_BROADCAST_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_TEXT_LENGTH = 1000;
export const PAUSE_OPEN_MESSAGE = 'A pause run is open; resume or close it first.';
export const BROADCAST_OPEN_MESSAGE = 'A broadcast is open; close it first.';
const NO_BROADCAST_MESSAGE = 'No broadcast is open; give a text.';

export interface BroadcastProgress {
  acked: number;
  total: number;
}

export interface BroadcastDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
  newToken?: () => string;
  selfPaneKey?: string;
  onProgress?: (progress: BroadcastProgress) => void;
  confirm?: Confirm;
  signal?: AbortSignal;
}

const ackLine = (token: string) => `ORCA-ACK ${token}`;

export function broadcastMessage(text: string, token: string): string {
  return (
    `[orca-broadcast] The user sends you this message: "${text}" Handle it now. If you are in the middle of a step, finish that step first. ` +
    `When you have handled it, end your reply with a short note on what you did. The last line of your reply must be exactly: ${ackLine(token)}`
  );
}

// Trims the text, then refuses what cannot be sent as one line. Lengths count Unicode code points; Cc includes tab and newlines.
export function normaliseText(raw: string): string {
  const text = raw.trim();
  if (text === '') throw new Error('empty text: nothing to broadcast');
  if (/\p{Cc}/u.test(text)) throw new Error('the text contains a control character (a newline or a tab, for example); a broadcast is one line');
  const length = [...text].length;
  if (length > MAX_TEXT_LENGTH) throw new Error(`the text is ${length} characters; the limit is ${MAX_TEXT_LENGTH}`);
  return text;
}

const isSendable = (row: AgentRow): boolean => row.agentType === 'claude' && !isWaitingLike(row.state);

function newTarget(row: AgentRow, roles: Roles): BroadcastTarget {
  return {
    paneKey: row.paneKey,
    repoId: row.repoId,
    repo: row.repo,
    worktreeId: row.worktreeId,
    worktreePath: row.path,
    worktree: row.worktree,
    ...roleInfoOf(roles, row.paneKey),
    lastHandle: null,
    baseline: null,
    messagePending: true,
    status: 'pending',
    reason: null,
  };
}

const confirmTarget = (t: Pick<BroadcastTarget, 'repo' | 'worktree' | 'role'>): ConfirmTarget => ({ repo: t.repo, worktree: t.worktree, role: t.role });

// This session, shown on its own line: it cannot ack while its own command waits.
function selfLine(selfKey: string | undefined, { agents, terminals, roles }: Snapshot): ConfirmTarget | null {
  const found = selfKey ? locate(selfKey, agents, terminals) : null;
  if (!found || 'gone' in found || found.row.agentType !== 'claude') return null;
  return confirmTarget({ repo: found.row.repo, worktree: found.row.worktree, role: roleInfoOf(roles, found.row.paneKey).role });
}

const nothingToBroadcast = (self: ConfirmTarget | null): RunSummary => ({ outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [], record: null, broadcastSelf: self });

// Interim rules, replaced by ticket #69: an open broadcast refuses every `broadcast`; the re-run that continues it comes with #69.
async function refuseOpenRecords(store: RecordStore, text: string | undefined): Promise<void> {
  const open = await store.loadOpen();
  if (open.pause) throw new Error(PAUSE_OPEN_MESSAGE);
  if (open.broadcast) throw new Error(BROADCAST_OPEN_MESSAGE);
  if (text === undefined) throw new Error(NO_BROADCAST_MESSAGE);
}

// `text` is already normalised, or undefined when the command line had none.
export async function broadcast(text: string | undefined, timeoutMs: number, deps: BroadcastDeps): Promise<RunSummary> {
  const { clock, store } = deps;
  const selfKey = deps.selfPaneKey || undefined; // an empty ORCA_PANE_KEY means there is no self
  let snapshot: Snapshot;
  let record: BroadcastRecord;
  try {
    throwIfAborted(deps.signal);
    await refuseOpenRecords(store, text);
    snapshot = await listSnapshot(deps);
    throwIfAborted(deps.signal);

    const selected = [...snapshot.agents.values()].filter((row) => {
      const found = locate(row.paneKey, snapshot.agents, snapshot.terminals);
      return !('gone' in found) && row.paneKey !== selfKey && isSendable(row);
    });
    const self = selfLine(selfKey, snapshot);
    if (selected.length === 0) return nothingToBroadcast(self);

    const token = (deps.newToken ?? randomToken)();
    const targets = coordinatorsFirst(selected.map((row) => newTarget(row, snapshot.roles)), (t) => t.role);
    if (deps.confirm && !(await deps.confirm(targets.map(confirmTarget), deps.signal, { message: broadcastMessage(text as string, token), self }))) return cancelled();
    throwIfAborted(deps.signal);

    // The answer may have taken minutes: refresh state only. The targets stay as confirmed; one that vanished is recorded as gone.
    snapshot = await listSnapshot(deps);
    const gone = markGone(targets, snapshot.agents, snapshot.terminals);
    if (gone === targets.length) return nothingToBroadcast(self);

    const createdAt = iso(clock.now());
    record = { id: `${createdAt.replace(/[-:.]/g, '')}-${token}`, token, text: text as string, createdAt, status: 'open', pid: store.pid, ...(store.startTime === undefined ? {} : { startTime: store.startTime }), targets };
    await store.saveBroadcast(record);
    try {
      await store.setCurrent('broadcast', record.id);
    } catch (error) {
      // The record exists, so the pid must not stay in it: nothing was sent yet.
      delete record.pid;
      delete record.startTime;
      await store.saveBroadcast(record).catch(() => {});
      return { ...failure(error, null), record };
    }
  } catch (error) {
    return failure(error, null);
  }

  const self = selfLine(selfKey, snapshot);
  const startedAt = clock.now();
  let summary: RunSummary;
  try {
    // Temporary: ticket #69 stops this loop early when every pending target is send-failed. Until then it waits for the timeout.
    while (true) {
      throwIfAborted(deps.signal);
      await poll(record, snapshot, deps);
      if (record.targets.every((t) => t.status !== 'pending')) record.status = 'closed';
      await store.saveBroadcast(record);
      deps.onProgress?.({ acked: record.targets.filter((t) => t.status === 'acked').length, total: record.targets.length });
      if (record.status === 'closed') break;
      await sleepOrAbort(clock, POLL_INTERVAL_MS, deps.signal);
      if (clock.now() - startedAt >= timeoutMs) break;
      snapshot = await listSnapshot(deps);
    }
    summary = { outcome: 'done', exitCode: record.targets.every((t) => t.status === 'acked') ? 0 : 1, run: null, error: null, rows: [], record, broadcastSelf: self };
  } catch (error) {
    summary = { ...failure(error, null), record, broadcastSelf: self };
  }

  // Every exit path clears the pid, so a stale one is never taken for a running broadcast.
  try {
    delete record.pid;
    delete record.startTime;
    await store.saveBroadcast(record);
    if (record.status === 'closed') await store.clearCurrent('broadcast', record.id);
  } catch (error) {
    if (summary.exitCode !== 130) summary = { ...failure(error, null), record, broadcastSelf: self };
  }
  return summary;
}

// Marks the targets that cannot be located any more; returns how many are gone.
function markGone(targets: BroadcastTarget[], agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>): number {
  for (const target of targets) {
    const found = locate(target.paneKey, agents, terminals);
    if ('gone' in found) {
      target.status = 'gone';
      target.reason = found.gone;
    }
  }
  return targets.filter((t) => t.status === 'gone').length;
}

function proves(target: BroadcastTarget, row: AgentRow, token: string): boolean {
  return !target.messagePending && !isWaitingLike(row.state) && hasNewReply(target.baseline, row) && endsWithLine(row.lastAssistantMessage, ackLine(token));
}

// One pass: locate, refresh, check the proof, then send to targets that still need the message. Acked and gone are permanent.
async function poll(record: BroadcastRecord, snapshot: Snapshot, deps: BroadcastDeps): Promise<void> {
  const { agents, terminals, roles } = snapshot;
  markGone(record.targets.filter((t) => t.status === 'pending'), agents, terminals);
  const live: { target: BroadcastTarget; row: AgentRow }[] = [];
  for (const target of record.targets.filter((t) => t.status === 'pending')) {
    const found = locate(target.paneKey, agents, terminals);
    if ('gone' in found) continue;
    target.lastHandle = found.handle;
    Object.assign(target, roleInfoOf(roles, target.paneKey));
    if (proves(target, found.row, record.token)) {
      target.status = 'acked';
      target.reason = null;
      continue;
    }
    // Temporary: ticket #69 adds the reason no-ack for a target that replied without the ack line. Until then it shows still-working.
    if (target.reason !== 'send-failed') target.reason = isWaitingLike(found.row.state) ? 'waiting-permission' : 'still-working';
    live.push({ target, row: found.row });
  }

  const message = broadcastMessage(record.text, record.token);
  for (const { target } of coordinatorsFirst(live, ({ target }) => target.role).filter(({ target, row }) => target.messagePending && target.reason !== 'send-failed' && !isWaitingLike(row.state))) {
    throwIfAborted(deps.signal);
    await deps.store.saveBroadcast(record);
    const [freshAgents, freshTerminals] = await listFresh(deps);
    const found = locate(target.paneKey, freshAgents, freshTerminals);
    if ('gone' in found) {
      markGone([target], freshAgents, freshTerminals);
      continue;
    }
    if (isWaitingLike(found.row.state)) {
      target.reason = 'waiting-permission';
      continue;
    }
    const result = await deps.port.send(found.handle, message).catch(() => ({ accepted: false as const }));
    if (result.accepted) {
      target.baseline = found.row.lastAssistantMessage;
      target.messagePending = false;
      target.reason = 'still-working';
    } else {
      target.reason = 'send-failed';
    }
    await deps.store.saveBroadcast(record);
  }
}
