import type { Progress } from './pause.js';
import type { AgentRecord, PauseStatus } from './types.js';

const HINTS: Partial<Record<PauseStatus, string>> = {
  unconfirmed: 'not confirmed paused; check these agents before you leave',
};

const GROUP_ORDER: PauseStatus[] = ['unconfirmed', 'confirmed'];

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function renderProgress(progress: Progress): string {
  const reasons = Object.entries(progress.reasons).map(([reason, count]) => `${count} ${reason}`);
  const parts = [`pausing… ${progress.confirmed}/${progress.total} confirmed`, ...reasons, `${formatRemaining(progress.remainingMs)} left`];
  return parts.join(' · ');
}

function table(rows: AgentRecord[]): string[] {
  const header = ['repo', 'worktree', 'role', 'status', 'reason'];
  const body = rows.map((a) => [a.repo, a.worktree, a.role, a.pauseStatus, a.pauseReason ?? '-']);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] as string).length)));
  const line = (cells: string[]) => `  ${cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ').trimEnd()}`;
  return [line(header), ...body.map(line)];
}

export function renderTable(agents: AgentRecord[]): string {
  const out: string[] = [];
  for (const status of GROUP_ORDER) {
    const group = agents.filter((a) => a.pauseStatus === status);
    if (group.length === 0) continue;
    const hint = HINTS[status];
    out.push(`${status} (${group.length})${hint ? ` - ${hint}` : ''}`, ...table(group), '');
  }
  return out.join('\n');
}
