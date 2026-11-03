# Fixtures

Redacted samples of real `orca-ide ... --json` output: `worktree-ps.json`, `terminal-list.json`,
`run-list.json`, `terminal-send-stale.json` (a real `terminal_handle_stale` error) and
`terminal-send-accepted.json` (a real accepted `terminal send --enter --json` receipt, with its
"no turn start was observed" warning). Ids, paths, names, prompts and messages are replaced by placeholders.

`worker-list.json` (`orchestration worker-list --terminal-state active --json`, trimmed to 3 of the 8 active workers at that moment),
`worker-list-page1.json` (the same call with `--limit 1`, a moment later, so its counts differ: a real page with `hasMore: true`; its opaque cursor is replaced by a
placeholder), `repo-list.json` (`repo list --json`, trimmed to 2 repos), `run-list-null-handle.json` (a real `run-list` with one run
whose `coordinator_handle` is null) and `worktree-ps-plain-handoff.json` (the `worktree ps` row of a child created by a plain handoff,
`worktree create --parent-worktree active --agent claude` without orchestration, in a throwaway worktree that was removed again: its
agent has `parentPaneKey: null`, so a plain handoff child is not a worker). All are captured 2026-10-06 and redacted the same way.

`worktree-list.json` is `worktree list --limit 10000 --json` (a read-only call) trimmed to 6 of the 57 worktrees of two repos (the two repos each keep a
`main` worktree, so a name repeats across repos), and `worktree-list-truncated.json` is the same call with `--limit 2`, a real page with `truncated: true` and
`totalCount: 57`. Ids, paths, branch names and other names are placeholders; the generic names `main` stay. Captured 2026-10-07 and redacted the same way.

`terminal-list-local-omitted.json` is derived, not a pure capture: `terminal-list.json` (captured 2026-10-06) with its `hostScope` replaced by the one
`terminal list --json` returned on 2026-10-09 after an Orca crash (Orca 1.4.223; quoted in issue #99): `hostIds: []`, `omittedHostIds: ["local"]` and
`omittedHostSelectors: [{hostId: "local", selector: "--host local"}]`. The rows, `truncated: false` and everything else are from the 2026-10-06 capture.

`terminal-send-truncated.txt` is synthetic: the stale-handle output cut off mid-JSON, as left by a timed-out
`terminal send` that still reported its request id.

`worktree-ps-woken-*.json` are redacted captures of one real Claude agent (from a throwaway terminal) that a
background `sleep` task wakes after its `ORCA-PAUSED` reply. Each file holds one agent row, in the worktree wrapper of
`worktree-ps.json`; the row itself is real except the placeholders:

- `-working-token`: the agent is `working` while the background task runs, and its last reply already ends with the token line.
- `-midturn`: after the wake-up, mid-turn, the agent is `working` and `lastAssistantMessage` is `null` (not an empty string).
- `-done-token`: the woken agent is `done` and its new reply ends with the same token line (it followed the new pause sentence).

`worktree-ps-background.json` is a redacted capture of one real Claude agent (throwaway terminal, Claude Code v2.1.296, 2026-10-12, case (b) of `docs/research/background-shell-state.md`) whose turn has ended while a background shell runs: `state: "working"`, `workingMode: "monitoring"`, `mainAgent.state: "done"`, and `lastAssistantMessage` holds the reply of the ended turn. One agent row in the worktree wrapper of the `-working-token` fixture (an older capture, so the wrapper's own timestamps are not from 2026-10-12); the prompt and `toolInput` are placeholders, the ids are the placeholders of that wrapper, and the row's own fields and timestamps are real.

`proc-stat.txt` is a real `/proc/<pid>/stat` line, read from a throwaway `cat` process (`cat /proc/self/stat`), with the pids
and the address fields replaced by placeholders. Field 22, the start time, is `3601991`. `proc-stat-odd-name.txt` is the same line with the
command name replaced by `(my (odd) cmd)`: synthetic, to cover a command name that contains spaces and parentheses.

## Restart recovery fixtures (captured 2026-11-03, issue 140)

Read-only captures from a live, resumed Claude Code process (Claude Code 2.1.316, Linux) of the current user, redacted. The base name of the first `cmdline` argument is `claude`. `sessions/<pid>.json` holds `procStart` (a string) that equals field 22 of `/proc/<pid>/stat` (clock ticks since boot, 100 per second), and a `startedAt` in epoch milliseconds. The `projects/` folder of that session is its working folder with every non-alphanumeric character replaced by `-`.

- `claude-session.json`: a `sessions/<pid>.json`. Keys and value types are real; `sessionId`, `cwd`, `name`, the socket path, the namespace id and the timestamps are placeholders. `procStart` is `43133`, the real tick value of the process.
- `claude-environ.bin`: a `/proc/<pid>/environ` excerpt, NUL-separated. Only `ORCA_*` names that the process had (7 of 24), with fake values.
- `claude-cmdline.bin`: a `/proc/<pid>/cmdline`, NUL-separated: `claude`, `--resume`, a fake session id.
- `claude-status.txt`: a `/proc/<pid>/status`. The `Uid:` line has the real shape (four numbers); the other lines are placeholders.
- `boot-id.txt`: a `/proc/sys/kernel/random/boot_id` (a fake UUID and a newline).
- `terminal-create.json`: the receipt of `orca-ide terminal create --worktree path:<path> --title <title> --command "echo ..." --json`, from a throwaway terminal that ran a harmless `echo` and was closed again (never `claude`). The handle is at `result.terminal.handle`. Ids, paths and the title are placeholders.

The `.bin` files hold NUL bytes; do not rewrite them with a text editor.
