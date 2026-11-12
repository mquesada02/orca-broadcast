import { describe, expect, it } from 'vitest';
import { createBlockDrawer, fitBlock, sortPendingRows } from '../src/block.js';
import type { PendingRow } from '../src/types.js';

const row = (repo: string, worktree: string, role: PendingRow['role'] = 'worker', reason: string | null = null): PendingRow => ({ repo, worktree, role, reason });
const rows = (n: number): PendingRow[] => Array.from({ length: n }, (_, i) => row('r', `w${i}`));

describe('sortPendingRows', () => {
  it('sorts by repo, then worktree, then role, with a plain comparison', () => {
    const sorted = sortPendingRows([row('b', 'a'), row('a', 'z', 'worker'), row('a', 'z', 'coordinator'), row('a', 'B'), row('a', 'a')]);
    expect(sorted.map((r) => `${r.repo}/${r.worktree}/${r.role}`)).toEqual(['a/B/worker', 'a/a/worker', 'a/z/coordinator', 'a/z/worker', 'b/a/worker']);
  });

  it('does not change its input', () => {
    const input = [row('b', 'a'), row('a', 'a')];
    sortPendingRows(input);
    expect(input[0]?.repo).toBe('b');
  });
});

describe('fitBlock', () => {
  it('aligns the columns to the widest drawn cell, indents rows by two spaces and trims trailing spaces', () => {
    const lines = fitBlock('count', [row('r', 'long-name', 'worker', 'no-ack'), row('r', 'x', 'coordinator')], { rows: 20, columns: 80 });
    expect(lines).toEqual(['count', '  r/long-name  worker       no-ack', '  r/x          coordinator']);
  });

  it('shows the count line alone when there are no pending rows', () => {
    expect(fitBlock('count', [], { rows: 20, columns: 80 })).toEqual(['count']);
  });

  it.each([
    ['no size', undefined],
    ['rows 0', { rows: 0, columns: 80 }],
    ['columns 0', { rows: 20, columns: 0 }],
    ['rows 3 (2 usable lines)', { rows: 3, columns: 80 }],
  ])('shows the count line alone with %s', (_name, size) => {
    expect(fitBlock('count', rows(2), size)).toEqual(['count']);
  });

  it('shows rows and `… and N more` from 3 usable lines', () => {
    expect(fitBlock('count', rows(3), { rows: 4, columns: 80 })).toEqual(['count', '  r/w0  worker', '  … and 2 more']);
  });

  it('uses every usable line when all the rows fit exactly', () => {
    expect(fitBlock('count', rows(3), { rows: 5, columns: 80 })).toHaveLength(4);
    expect(fitBlock('count', rows(3), { rows: 5, columns: 80 }).join('\n')).not.toContain('more');
  });

  it('shows rows - 3 rows and the number of rows left out when the rows do not fit', () => {
    const lines = fitBlock('count', rows(10), { rows: 8, columns: 80 });
    expect(lines).toHaveLength(7);
    expect(lines.at(-1)).toBe('  … and 5 more');
  });

  it('cuts every line to columns - 1 characters, counted in code points', () => {
    expect(fitBlock('count 😀😀😀', rows(1), { rows: 20, columns: 9 })).toEqual(['count 😀😀', '  r/w0  ']);
  });
});

describe('createBlockDrawer', () => {
  const size = { rows: 20, columns: 80 };

  it('draws with `\\r` and erase below, with no cursor up for the first block', () => {
    const out: string[] = [];
    createBlockDrawer((t) => out.push(t), () => size).draw('count', rows(1));
    expect(out).toEqual(['\r\x1b[Jcount\n  r/w0  worker']);
  });

  it('moves the cursor up by the lines of the previous block minus one at a redraw', () => {
    const out: string[] = [];
    const block = createBlockDrawer((t) => out.push(t), () => size);
    block.draw('count', rows(3));
    block.draw('count', rows(1));
    block.draw('count', []);
    expect(out[1]).toBe('\r\x1b[3A\x1b[Jcount\n  r/w0  worker');
    expect(out[2]).toBe('\r\x1b[1A\x1b[Jcount');
  });

  it('clears with the same prefix, writes also when nothing was drawn, and forgets the block', () => {
    const out: string[] = [];
    const block = createBlockDrawer((t) => out.push(t), () => size);
    block.clear();
    block.draw('count', rows(2));
    block.clear();
    block.clear();
    expect(out).toEqual(['\r\x1b[J', '\r\x1b[Jcount\n  r/w0  worker\n  r/w1  worker', '\r\x1b[2A\x1b[J', '\r\x1b[J']);
  });

  it('reads the size once at each draw and never at a clear', () => {
    let reads = 0;
    const block = createBlockDrawer(() => {}, () => (reads += 1, size));
    block.draw('count', []);
    block.clear();
    block.draw('count', []);
    expect(reads).toBe(2);
  });

  it('draws the count line alone when it has no size function', () => {
    const out: string[] = [];
    createBlockDrawer((t) => out.push(t)).draw('count', rows(2));
    expect(out).toEqual(['\r\x1b[Jcount']);
  });
});
