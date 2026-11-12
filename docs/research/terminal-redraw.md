# Redrawing a multi-line block on stderr

Snapshot of 2026-11-11, for ticket #263 (map #261). The library sources are the `main`/`master` branches as read on that date.

## Question

How can a Node.js CLI redraw a block of several lines on stderr in place, safely, while it waits?

## Short answer

- Move up and erase with plain CSI sequences (below). A few lines of own code are enough; no dependency is needed.
- Keep the block shorter than `rows` and each line shorter than `columns`. Then the line count you draw is the line count the terminal shows, and the cursor-up count is right.
- Redraw only when stderr is a TTY. Clear the block when the wait ends. Do not hide the cursor, so nothing has to be restored after a SIGINT.

## Escape sequences

xterm control sequences ([ctlseqs, XFree86 copy](https://www.xfree86.org/current/ctlseqs.html)):

- `CSI Ps A` is "Cursor Up Ps Times (default = 1) (CUU)". The page does not say what happens at the top row.
- `CSI Ps K` is "Erase in Line (EL)": `0` erase to right (default), `1` to left, `2` all.
- `CSI Ps J` is "Erase in Display (ED)": `0` erase below (default), `1` above, `2` all, `3` saved lines.
- `CSI Ps G` is "Cursor Character Absolute [column] (default = [row,1]) (CHA)".
- `CSI ? 7 h/l` is "Wraparound Mode (DECAWM)"; `CSI ? 25 h/l` is "Show Cursor (DECTCEM)".

The xterm host `invisible-island.net` answered 403 to the fetch tool, so the XFree86 copy of ctlseqs was read. ECMA-48, the base standard for CSI, was not read.

How well-known code uses them. [ansi-escapes `base.js`](https://raw.githubusercontent.com/sindresorhus/ansi-escapes/main/base.js):

- `cursorUp = (count = 1) => ESC + count + 'A'`, `eraseLine = ESC + '2K'`, `eraseEndLine = ESC + 'K'`, `cursorLeft = ESC + 'G'`, `cursorHide = ESC + '?25l'`, `cursorShow = ESC + '?25h'`.
- `eraseLines(count)` repeats `eraseLine` and `cursorUp()` for each line, with no cursor-up after the last line, then ends with `cursorLeft`.

The same effect with fewer bytes: `\x1b[{n}A` (up n lines), `\r` (column 1), `\x1b[J` (erase below). The project's `CLEAR_LINE = '\r\x1b[K'` in `src/cli.ts` is the one-line form of this.

## Block taller than the terminal, lines wider than the terminal

[log-update `index.js`](https://raw.githubusercontent.com/sindresorhus/log-update/main/index.js), as read:

- It remembers `previousLineCount`, the number of terminal rows of the last frame, and erases that many.
- It wraps each frame to `stream.columns` (fallback 80) with `wrap-ansi` (hard wrap), so the count it stores is the wrapped row count.
- `fitToTerminalHeight` reads `stream.rows` (fallback 24) and cuts the frame to fit; a clipped frame forces a full erase and redraw.
- On a width change it erases fully and redraws.
- On a TTY it wraps writes in synchronized-output sequences (`?2026h` / `?2026l`), to reduce flicker.

Why this matters: a block taller than `rows` cannot be erased from its first line (the sequences cannot reach above the visible screen; the xterm page is silent on the clamp, so this is inferred, not quoted), and a line wider than `columns` takes two rows, so "N lines" is wrong. Counting wrapped rows needs width-aware code (ANSI codes, wide characters).

For this project the block is plain text that the CLI builds itself, so it can avoid the problem instead of measuring it:

- Cut each line to `columns - 1` characters. This is the author's design choice, not stated by the sources; leaving the last column free avoids relying on the terminal's pending-wrap behaviour. Turning wrapping off with DECAWM would also work but must be restored on exit; truncation needs no restore.
- Show at most `rows - 1` lines. If there are more, end with a line such as `... and N more`.
- Take `rows` and `columns` from `process.stderr` at each draw. If either is missing, draw no block.

Node [tty docs](https://nodejs.org/api/tty.html): `writeStream.columns` and `writeStream.rows` are "updated whenever the `'resize'` event is emitted"; `'resize'` is "emitted whenever either of the `writeStream.columns` or `writeStream.rows` properties have changed". The preferred TTY check is the stream's `isTTY` property.

## Terminal resize

Reading `columns` and `rows` fresh at each draw is enough if the block is redrawn on each progress event or timer tick. Like log-update, treat a width change as a full erase and redraw rather than a diff. How a terminal re-wraps lines already drawn at the old width when the window narrows is terminal-dependent and was not tested (no terminal was driven). Truncating at draw time keeps the common case right. A `process.stderr.on('resize', ...)` redraw is optional and needs an `off` when the wait ends.

## Leaving the screen clean

- listr2 ([default renderer](https://raw.githubusercontent.com/listr2/listr2/master/packages/listr2/src/renderer/default/renderer.ts)) uses `createLogUpdate` from log-update. Its `end()` stops the spinner, unsubscribes the refresh listener, calls `updater.clear()` and `updater.done()`, then writes the final frame directly, with a code comment that "logupdate only can update the seen height of terminal". It reads only the width itself and leaves height to log-update.
- log-update: `done()` resets state and restores the cursor but does not erase; `clear()` erases the frame; `persist(text)` erases, writes text that stays, and resets.
- Hiding the cursor needs a restore. [restore-cursor](https://raw.githubusercontent.com/sindresorhus/restore-cursor/main/index.js) writes `\u001B[?25h` from an exit hook (`signal-exit`, `alwaysLast`). If the block does not hide the cursor, no hook is needed. Recommendation: do not hide it.
- SIGINT: this project already routes SIGINT, SIGTERM and SIGHUP through `STOP_SIGNALS` in `src/guard.ts` (`withLockAndSignals`), which aborts the command's `AbortSignal` so the command returns normally. So a block clear after the command (today `if (io.isTTY && command !== 'close') io.stderr(CLEAR_LINE)` in `src/cli.ts`) also runs after a SIGINT. A clear in a `finally` would also cover a thrown error. SIGKILL cannot be handled by any code.

## Dependency or own code

`package.json` has no runtime dependencies (no `dependencies` key; only `@types/node`, `typescript` and `vitest` as dev dependencies) and `engines.node` is `>=22`. log-update pulls in ansi-escapes, wrap-ansi and slice-ansi, and its clip and wrap logic exists for arbitrary ANSI text and wide characters, which this block does not have. Recommendation: own code, about 20 lines: a draw function that erases the previous block, truncates, caps and writes, and a clear function.

## How the block would replace today's one-line progress

Today (`src/cli.ts`):

- `CLEAR_LINE = '\r\x1b[K'`.
- `progressLine(render)` returns `undefined` unless `io.isTTY && !json`, otherwise a callback that writes `${CLEAR_LINE}${render(progress)}` to stderr. Only `resume` passes it (`onProgress: progressLine(renderResumeProgress)`); `renderResumeProgress` returns one string.
- After the command, `CLEAR_LINE` clears the line. Both confirm prompts also write `CLEAR_LINE` first when `io.isTTY`.

With a block:

- The render function returns `string[]`. `progressLine` keeps its TTY and `!json` guard but writes the erase of the previous block, then the new lines, and remembers the number of lines drawn (new state).
- Every place that writes `CLEAR_LINE` today (post-command, both confirm prompts) must clear the block instead: `\r`, cursor up `n - 1`, `\x1b[J` (the cursor rests on the last line of the block, with no trailing newline). With one line this is the same as today. These sites must share the one remembered count.
- Rows and columns come from the stderr stream, but `CliIo` has only `stderr(text)` and `isTTY`; the size would have to reach the code through `CliIo` so tests can set it (tests never use a real terminal).
- Non-TTY and `--json` paths stay as they are: nothing is drawn.

## Not verified

- No terminal was driven; the behaviour above comes from documentation and library sources.
- Cursor-up at the top row is not stated by the xterm page.
- The ECMA-48 text was not read.
