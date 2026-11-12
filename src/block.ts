import type { PendingRow } from './types.js';

export interface TerminalSize {
  rows: number;
  columns: number;
}

// A plain comparison, not `localeCompare`: the order must not depend on the locale of the process.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The pending rows of a block in their fixed order: repo, then worktree, then role. */
export const sortPendingRows = (rows: PendingRow[]): PendingRow[] =>
  [...rows].sort((a, b) => compare(a.repo, b.repo) || compare(a.worktree, b.worktree) || compare(a.role, b.role));

// One line per row: two-space indent, columns aligned to the widest cell, two spaces between columns, trailing spaces trimmed.
function rowLines(rows: PendingRow[]): string[] {
  const cells = rows.map((r) => [`${r.repo}/${r.worktree}`, r.role, r.reason ?? '']);
  const widths = [0, 1, 2].map((i) => Math.max(...cells.map((c) => (c[i] as string).length)));
  return cells.map((c) => `  ${c.map((cell, i) => cell.padEnd(widths[i] as number)).join('  ').trimEnd()}`);
}

/**
 * The lines of the block for a terminal size: the count line, then the pending rows.
 * With no known size (0, or no function), or under 3 usable lines (`rows - 1`), the block is the count line alone.
 * When the rows do not fit, `rows - 3` rows show, then `… and N more`. Every line is cut to `columns - 1` characters.
 */
export function fitBlock(count: string, pending: PendingRow[], size: TerminalSize | undefined): string[] {
  if (!size || size.rows <= 0 || size.columns <= 0 || size.rows - 1 < 3) return [count];
  const maxLines = size.rows - 1;
  const fits = 1 + pending.length <= maxLines;
  const shown = fits ? pending : pending.slice(0, maxLines - 2);
  const lines = [count, ...rowLines(shown), ...(fits ? [] : [`  … and ${pending.length - shown.length} more`])];
  return lines.map((line) => Array.from(line).slice(0, size.columns - 1).join(''));
}

export interface BlockDrawer {
  /** Redraws the block in place: the count line and the pending rows, fitted to the size at this moment. */
  draw: (count: string, pending: PendingRow[]) => void;
  /** Erases the block that is on screen. It writes also when none was drawn, and it reads no size. */
  clear: () => void;
}

/** Draws a block on a terminal: `\r`, cursor up (lines of the previous block minus one), erase below, then the new lines. */
export function createBlockDrawer(write: (text: string) => void, size?: () => TerminalSize): BlockDrawer {
  let lines = 0;
  const prefix = () => `\r${lines > 1 ? `\x1b[${lines - 1}A` : ''}\x1b[J`;
  return {
    draw(count, pending) {
      const block = fitBlock(count, pending, size?.());
      write(prefix() + block.join('\n'));
      lines = block.length;
    },
    clear() {
      write(prefix());
      lines = 0;
    },
  };
}
