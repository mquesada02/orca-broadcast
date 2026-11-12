import type { TerminalSize } from '../../src/block.js';

/** The clear of the block: back to the line start, then erase to the end of the screen. */
export const CLEAR = '\r\x1b[J';

/** A terminal large enough that no block is cut or capped. */
export const roomy: TerminalSize = { rows: 30, columns: 100 };

/** The blocks that were drawn: every chunk of stderr that starts a redraw, cut at the next redraw or at the final clear. */
export const chunks = (err: string): string[] => err.split(/(?=\r(?:\x1b\[\d+A)?\x1b\[J)/).filter((c) => c !== '');
