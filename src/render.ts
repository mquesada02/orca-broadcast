import type { AgentRecord, PauseStatus, Progress, ResumeProgress, ResumeStatus } from './types.js';

const HINTS: Partial<Record<PauseStatus, string>> = {
  unconfirmed: 'not confirmed paused; check these agents before you leave',
};

const RESUME_HINTS: Partial<Record<ResumeStatus, string>> = {
  pending: "run resume again; for a waiting-permission row, first answer the permission prompt in that row's worktree",
  gone: 'terminal or Claude is gone; restart these agents yourself',
};

const RESUME_GROUP_ORDER: ResumeStatus[] = ['pending', 'gone', 'resumed'];

const ABANDONED_HINT = 'still paused — continue it by hand';

const PAUSED_AGENT_HINT = 'paused and waiting for CONTINUE — run resume before close, or continue it by hand';

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function renderProgress(progress: Progress): string {
  const reasons = Object.entries(progress.reasons).map(([reason, count]) => `${count} ${reason}`);
  const parts = [`pausing… ${progress.confirmed}/${progress.total} confirmed`, ...reasons, `${formatRemaining(progress.remainingMs)} left`];
  return parts.join(' · ');
}

export function renderResumeProgress(progress: ResumeProgress): string {
  return `resuming… ${progress.resumed}/${progress.total} resumed`;
}

function table(rows: AgentRecord[], statusOf: (a: AgentRecord) => string, reasonOf: (a: AgentRecord) => string | null | undefined): string[] {
  const header = ['repo', 'worktree', 'role', 'run', 'status', 'reason'];
  const body = rows.map((a) => [a.repo, a.worktree, a.role, a.orchestrationRunIds.length > 0 ? a.orchestrationRunIds.join(', ') : 'run: unknown', statusOf(a), reasonOf(a) ?? '-']);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] as string).length)));
  const line = (cells: string[]) => `  ${cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ').trimEnd()}`;
  return [line(header), ...body.map(line)];
}

function renderGroups<S extends string>(
  agents: AgentRecord[],
  order: S[],
  hints: Partial<Record<S, string>>,
  statusOf: (a: AgentRecord) => S,
  reasonOf: (a: AgentRecord) => string | null | undefined,
): string {
  const out: string[] = [];
  for (const status of order) {
    const group = agents.filter((a) => statusOf(a) === status);
    if (group.length === 0) continue;
    const hint = hints[status];
    out.push(`${status} (${group.length})${hint ? ` - ${hint}` : ''}`, ...table(group, statusOf, reasonOf), '');
  }
  return out.join('\n');
}

// The agents of an output that have a role but no known run. A session with no run is normal and is not counted.
export function renderUnknownRuns(agents: AgentRecord[]): string {
  const count = agents.filter((a) => a.role !== 'session' && a.orchestrationRunIds.length === 0).length;
  return count > 0 ? `${count} agents have a role but no known run\n` : '';
}

const SELF_HEADING = 'self (not paused) — this session must stop by itself';

export function renderSelfBlock(self: AgentRecord): string {
  return [SELF_HEADING, ...table([self], () => 'self', () => null), ''].join('\n');
}

export function renderTable(agents: AgentRecord[], self: AgentRecord | null = null): string {
  const group = (status: PauseStatus) =>
    renderGroups(agents, [status], HINTS, (a) => a.pauseStatus, (a) => (a.resumeStatus === 'gone' ? a.resumeReason : a.pauseReason));
  return [group('unconfirmed'), self ? renderSelfBlock(self) : '', group('confirmed')].filter((part) => part !== '').join('\n');
}

export function renderResumeTable(agents: AgentRecord[]): string {
  return renderGroups(agents, RESUME_GROUP_ORDER, RESUME_HINTS, (a) => a.resumeStatus, (a) => a.resumeReason);
}

export function renderCloseTable(agents: AgentRecord[]): string {
  if (agents.length === 0) return '';
  const reasonOf = (a: AgentRecord) => (a.pauseStatus === 'confirmed' ? PAUSED_AGENT_HINT : a.pauseReason);
  return [`abandoned (${agents.length}) - ${ABANDONED_HINT}`, ...table(agents, (a) => a.pauseStatus, reasonOf), ''].join('\n');
}
