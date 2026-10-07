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

`terminal-send-truncated.txt` is synthetic: the stale-handle output cut off mid-JSON, as left by a timed-out
`terminal send` that still reported its request id.

`worktree-ps-woken-*.json` are redacted captures of one real Claude agent (from a throwaway terminal) that a
background `sleep` task wakes after its `ORCA-PAUSED` reply. Each file holds one agent row, in the worktree wrapper of
`worktree-ps.json`; the row itself is real except the placeholders:

- `-working-token`: the agent is `working` while the background task runs, and its last reply already ends with the token line.
- `-midturn`: after the wake-up, mid-turn, the agent is `working` and `lastAssistantMessage` is `null` (not an empty string).
- `-done-token`: the woken agent is `done` and its new reply ends with the same token line (it followed the new pause sentence).

`proc-stat.txt` is a real `/proc/<pid>/stat` line, read from a throwaway `cat` process (`cat /proc/self/stat`), with the pids
and the address fields replaced by placeholders. Field 22, the start time, is `3601991`. `proc-stat-odd-name.txt` is the same line with the
command name replaced by `(my (odd) cmd)`: synthetic, to cover a command name that contains spaces and parentheses.
