import { sleepOrAbort, throwIfAborted } from './abort.js';
import { isFiltered, matches, NO_FILTERS, type Subject } from './filters.js';
import { BROADCAST_OPEN_MESSAGE, cancelled, clearPid, coordinatorsFirst, endsWithLine, failure, hasNewReply, isSendable, isWaitingLike, iso, listFresh, listSnapshot, liveSources, locate, POLL_INTERVAL_MS, randomToken, recordId, releaseBroadcast, resolveFilterSet, roleInfoOf, setPid, subjectOfRow, withWarnings, type RecordedIdentity, type Roles, type Snapshot } from './shared.js';
import type { RecordStore } from './store.js';
import type { AgentRow, BroadcastRecord, BroadcastSelf, BroadcastTarget, Clock, Confirm, ConfirmTarget, FilterSet, FilterSpec, GroupFilter, LocateReason, OrcaPort, RunSummary, TerminalRow } from './types.js';

const MAX_TEXT_LENGTH = 4000;
const NO_BROADCAST_MESSAGE = 'No broadcast is open; give a text.';
const PAUSE_OPEN_MESSAGE = 'A pause run is open; resume or close it first.';

export interface BroadcastProgress {
  acked: number;
  total: number;
}

interface BroadcastDeps {
  port: OrcaPort;
  clock: Clock;
  store: RecordStore;
  newToken?: () => string;
  selfPaneKey?: string;
  onProgress?: (progress: BroadcastProgress) => void;
  confirm?: Confirm;
  signal?: AbortSignal;
  /** The filters and the groups of the command line, and the folder a relative `--worktree` path is resolved from. */
  filters?: FilterSpec;
  groups?: GroupFilter[];
  cwd?: string;
}

const ackLine = (token: string) => `ORCA-ACK ${token}`;

const END_MARKER = '[end of message]';

// A text with a newline goes on its own lines between a start and an end marker; the ack instruction always comes last.
export function broadcastMessage(text: string, token: string): string {
  const message = text.includes('\n')
    ? `[orca-broadcast] The user sends you this message. It starts on the next line and ends at the line "${END_MARKER}".\n${text}\n${END_MARKER}\nHandle it now.`
    : `[orca-broadcast] The user sends you this message: "${text}" Handle it now.`;
  return (
    `${message} If you are in the middle of a step, finish that step first. ` +
    `When you have handled it, end your reply with a short note on what you did. The last line of your reply must be exactly: ${ackLine(token)}`
  );
}

// Trims the text, turns CRLF into LF, then refuses every control character except the newline. Lengths count Unicode code points, after the CRLF conversion.
export function normaliseText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('empty text: nothing to broadcast');
  const text = trimmed.replaceAll('\r\n', '\n');
  if (/(?!\n)\p{Cc}/u.test(text)) throw new Error('the text contains a control character; the only control character allowed is a newline (a tab or a lone carriage return is not)');
  const length = [...text].length;
  if (length > MAX_TEXT_LENGTH) throw new Error(`the text is ${length} characters; the limit is ${MAX_TEXT_LENGTH}`);
  return text;
}

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

// This session, shown on its own line: it cannot ack while its own command waits. When it is a recorded target, its saved status shows too,
// and the line is built from the record if the session is not a live Claude agent.
function selfLine(selfKey: string | undefined, { agents, terminals, roles }: Snapshot, record?: BroadcastRecord): BroadcastSelf | null {
  if (!selfKey) return null;
  const found = locate(selfKey, agents, terminals);
  const live = 'gone' in found || found.row.agentType !== 'claude' ? null : confirmTarget({ repo: found.row.repo, worktree: found.row.worktree, role: roleInfoOf(roles, found.row.paneKey).role });
  const saved = record?.targets.find((t) => t.paneKey === selfKey);
  return saved ? { ...(live ?? confirmTarget(saved)), status: saved.status, reason: saved.reason } : live;
}

const nothingToBroadcast = (self: BroadcastSelf | null): RunSummary => ({ outcome: 'nothing-to-do', exitCode: 0, run: null, error: null, rows: [], record: null, broadcastSelf: self });

// `givenText` is already normalised, or undefined when the command line had none. No text, or the open broadcast's own text, continues that broadcast.
export function broadcast(givenText: string | undefined, timeoutMs: number, deps: BroadcastDeps): Promise<RunSummary> {
  return withWarnings((warnings) => runBroadcast(givenText, timeoutMs, deps, warnings));
}

async function runBroadcast(givenText: string | undefined, timeoutMs: number, deps: BroadcastDeps, warnings: string[]): Promise<RunSummary> {
  let open: BroadcastRecord | undefined;
  try {
    throwIfAborted(deps.signal);
    open = await openBroadcast(deps.store, givenText, warnings);
  } catch (error) {
    return failure(error, null);
  }
  return open ? rerun(open, timeoutMs, deps) : firstBroadcast(givenText as string, timeoutMs, deps);
}

// The record checks: the open broadcast to continue, or undefined when a new one starts.
async function openBroadcast(store: RecordStore, text: string | undefined, warnings: string[]): Promise<BroadcastRecord | undefined> {
  const open = await store.loadOpen();
  warnings.push(...open.notes);
  if (open.pause) throw new Error(PAUSE_OPEN_MESSAGE);
  const record = open.broadcast?.record;
  if (!record && text === undefined) throw new Error(NO_BROADCAST_MESSAGE);
  if (record && text !== undefined && text !== record.text) throw new Error(BROADCAST_OPEN_MESSAGE);
  return record;
}

// The filters and the groups of this invocation, resolved once against the live listings and the identity saved in a record.
async function resolveScope(deps: BroadcastDeps, snapshot: Snapshot, recorded: RecordedIdentity[]): Promise<FilterSet> {
  const filters = deps.filters ?? NO_FILTERS;
  return resolveFilterSet(filters, isFiltered(filters, deps.groups) ? await liveSources(snapshot, deps) : null, recorded, deps.cwd, deps.groups);
}

async function firstBroadcast(text: string, timeoutMs: number, deps: BroadcastDeps): Promise<RunSummary> {
  const { clock, store } = deps;
  const selfKey = deps.selfPaneKey || undefined; // an empty ORCA_PANE_KEY means there is no self
  let snapshot: Snapshot;
  let record: BroadcastRecord;
  let self: BroadcastSelf | null;
  try {
    throwIfAborted(deps.signal);
    snapshot = await listSnapshot(deps);
    throwIfAborted(deps.signal);

    const set = await resolveScope(deps, snapshot, []);
    const selected = [...snapshot.agents.values()].filter((row) => {
      const found = locate(row.paneKey, snapshot.agents, snapshot.terminals);
      return !('gone' in found) && row.paneKey !== selfKey && isSendable(row) && matches(set, { ...subjectOfRow(row, snapshot.roles), state: row.state });
    });
    self = selfLine(selfKey, snapshot);
    if (selected.length === 0) return nothingToBroadcast(self);

    const token = (deps.newToken ?? randomToken)();
    const targets = coordinatorsFirst(selected.map((row) => newTarget(row, snapshot.roles)), (t) => t.role);
    if (deps.confirm && !(await deps.confirm(targets.map(confirmTarget), deps.signal, { message: broadcastMessage(text, token), self }))) return cancelled();
    throwIfAborted(deps.signal);

    // The answer may have taken minutes: refresh state only. The targets stay as confirmed; one that vanished is recorded as gone.
    snapshot = await listSnapshot(deps);
    const gone = markGone(targets, snapshot.agents, snapshot.terminals);
    if (gone === targets.length) return nothingToBroadcast(self);

    const now = clock.now();
    record = { id: recordId(now, token), token, text, createdAt: iso(now), status: 'open', targets };
    setPid(record, store);
    await store.saveBroadcast(record);
    try {
      await store.setCurrent('broadcast', record.id);
    } catch (error) {
      // The record exists, so the pid must not stay in it: nothing was sent yet.
      releaseBroadcast(record);
      await store.saveBroadcast(record).catch(() => {});
      return { ...failure(error, null), record };
    }
  } catch (error) {
    return failure(error, null);
  }
  return wait({ record, scope: new Set(record.targets.map((t) => t.paneKey)), snapshot, self }, timeoutMs, deps);
}

// Continues the open broadcast: same token, only the in-scope targets, and a send only to targets that never got the message.
async function rerun(saved: BroadcastRecord, timeoutMs: number, deps: BroadcastDeps): Promise<RunSummary> {
  const { store } = deps;
  // `saved` is the record as loaded. Every exit before the working copy's first save writes it back with only the pid fields changed.
  setPid(saved, store);
  try {
    await store.saveBroadcast(saved);
  } catch (error) {
    return failure(error, null);
  }

  const record = structuredClone(saved);
  let prepared: Prepared;
  try {
    prepared = await prepareRerun(record, deps);
  } catch (error) {
    prepared = { summary: failure(error, null) };
  }
  if ('plan' in prepared) {
    return wait(prepared.plan, timeoutMs, deps);
  }
  try {
    clearPid(saved);
    await store.saveBroadcast(saved);
  } catch (error) {
    if (prepared.summary.exitCode !== 130) return failure(error, null);
  }
  return prepared.summary;
}

type Prepared = { summary: RunSummary } | { plan: Plan };

interface Plan {
  record: BroadcastRecord;
  /** The pane keys this invocation selected: the ones it sends to, waits on and counts in the exit code. */
  scope: Set<string>;
  snapshot: Snapshot;
  self: BroadcastSelf | null;
}

// What a re-run decides before its first save: the scope, the prompt and the refresh after "yes". Changes only the working copy.
async function prepareRerun(record: BroadcastRecord, deps: BroadcastDeps): Promise<Prepared> {
  const selfKey = deps.selfPaneKey || undefined;
  throwIfAborted(deps.signal);
  let snapshot = await listSnapshot(deps);
  throwIfAborted(deps.signal);

  const set = await resolveScope(deps, snapshot, record.targets);
  const self = selfLine(selfKey, snapshot, record);
  const inScope = record.targets.filter((t) => t.status !== 'abandoned' && t.paneKey !== selfKey && matches(set, savedSubject(t, snapshot)));
  if (inScope.length === 0) return { summary: nothingToBroadcast(self) };

  const pending = inScope.filter((t) => t.status === 'pending');
  markGone(pending, snapshot.agents, snapshot.terminals);
  for (const target of pending) if (target.reason === 'send-failed') target.reason = null; // sent again below; saved only with the first save after "yes"
  const needsSend = pending.filter((t) => t.status === 'pending' && t.messagePending);
  if (needsSend.length > 0) {
    const targets = coordinatorsFirst(needsSend, (t) => t.role).map(confirmTarget);
    if (deps.confirm && !(await deps.confirm(targets, deps.signal, { message: broadcastMessage(record.text, record.token), self }))) return { summary: cancelled() };
    throwIfAborted(deps.signal);
    snapshot = await listSnapshot(deps);
    markGone(pending.filter((t) => t.status === 'pending'), snapshot.agents, snapshot.terminals);
  }
  return { plan: { record, scope: new Set(inScope.map((t) => t.paneKey)), snapshot, self } };
}

// The values a recorded target is matched on: what the record saved, and its live state when it can be located now.
function savedSubject(target: BroadcastTarget, { agents, terminals }: Snapshot): Subject {
  const found = target.status === 'gone' ? null : locate(target.paneKey, agents, terminals);
  return { repoId: target.repoId, worktreeId: target.worktreeId, role: target.role, orchestrationRunIds: target.orchestrationRunIds, ...(found && !('gone' in found) ? { state: found.row.state } : {}) };
}

// The wait loop shared by a first broadcast and a re-run: poll, save, sleep, until the targets in scope are settled, none can progress, or the timeout.
async function wait({ record, scope, snapshot: first, self }: Plan, timeoutMs: number, deps: BroadcastDeps): Promise<RunSummary> {
  const { clock, store } = deps;
  let snapshot = first;
  const startedAt = clock.now();
  let summary: RunSummary;
  try {
    // The first save of the working copy: a re-run's changes (send-failed cleared, targets gone) become durable here and not before.
    await store.saveBroadcast(record);
    while (true) {
      throwIfAborted(deps.signal);
      await poll(record, scope, snapshot, deps);
      if (record.targets.every((t) => t.status !== 'pending')) record.status = 'closed';
      await store.saveBroadcast(record);
      const scoped = record.targets.filter((t) => scope.has(t.paneKey));
      deps.onProgress?.({ acked: scoped.filter((t) => t.status === 'acked').length, total: scoped.length });
      // Ends when nothing in scope is pending, or every pending target in scope is send-failed (no target can progress).
      if (record.status === 'closed' || scoped.filter((t) => t.status === 'pending').every((t) => t.reason === 'send-failed')) break;
      await sleepOrAbort(clock, POLL_INTERVAL_MS, deps.signal);
      if (clock.now() - startedAt >= timeoutMs) break;
      snapshot = await listSnapshot(deps);
    }
    summary = { outcome: 'done', exitCode: record.targets.every((t) => !scope.has(t.paneKey) || t.status === 'acked') ? 0 : 1, run: null, error: null, rows: [], record, broadcastSelf: self };
  } catch (error) {
    summary = { ...failure(error, null), record, broadcastSelf: self };
  }

  // Every exit path clears the pid, so a stale one is never taken for a running broadcast.
  try {
    releaseBroadcast(record);
    await store.saveBroadcast(record);
    if (record.status === 'closed') await store.clearCurrent('broadcast', record.id);
  } catch (error) {
    if (summary.exitCode !== 130) summary = { ...failure(error, null), record, broadcastSelf: self };
  }
  return summary;
}

const setGone = (target: BroadcastTarget, reason: LocateReason): void => {
  target.status = 'gone';
  target.reason = reason;
};

// Marks the targets that cannot be located any more; returns how many are gone.
function markGone(targets: BroadcastTarget[], agents: Map<string, AgentRow>, terminals: Map<string, TerminalRow>): number {
  for (const target of targets) {
    const found = locate(target.paneKey, agents, terminals);
    if ('gone' in found) setGone(target, found.gone);
  }
  return targets.filter((t) => t.status === 'gone').length;
}

function proves(target: BroadcastTarget, row: AgentRow, token: string): boolean {
  return !target.messagePending && !isWaitingLike(row.state) && hasNewReply(target.baseline, row) && endsWithLine(row.lastAssistantMessage, ackLine(token));
}

// One pass: locate, refresh, check the proof, then send to targets that still need the message. Acked and gone are permanent.
async function poll(record: BroadcastRecord, scope: Set<string>, snapshot: Snapshot, deps: BroadcastDeps): Promise<void> {
  const { agents, terminals, roles } = snapshot;
  const live: { target: BroadcastTarget; row: AgentRow }[] = [];
  for (const target of record.targets.filter((t) => t.status === 'pending' && scope.has(t.paneKey))) {
    const found = locate(target.paneKey, agents, terminals);
    if ('gone' in found) {
      setGone(target, found.gone);
      continue;
    }
    target.lastHandle = found.handle;
    Object.assign(target, roleInfoOf(roles, target.paneKey));
    if (proves(target, found.row, record.token)) {
      target.status = 'acked';
      target.reason = null;
      continue;
    }
    // no-ack only says that the agent replied without the ack line: it is not sent the message again, and a later ack still counts.
    if (target.reason !== 'send-failed') {
      target.reason = isWaitingLike(found.row.state) ? 'waiting-permission' : !target.messagePending && hasNewReply(target.baseline, found.row) ? 'no-ack' : 'still-working';
    }
    live.push({ target, row: found.row });
  }

  const message = broadcastMessage(record.text, record.token);
  const needsSend = ({ target, row }: { target: BroadcastTarget; row: AgentRow }) => target.messagePending && target.reason !== 'send-failed' && !isWaitingLike(row.state);
  for (const { target } of coordinatorsFirst(live.filter(needsSend), ({ target }) => target.role)) {
    throwIfAborted(deps.signal);
    await deps.store.saveBroadcast(record);
    const [freshAgents, freshTerminals] = await listFresh(deps);
    const found = locate(target.paneKey, freshAgents, freshTerminals);
    if ('gone' in found) {
      setGone(target, found.gone);
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
