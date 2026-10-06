# Fixtures

Redacted samples of real `orca-ide ... --json` output: `worktree-ps.json`, `terminal-list.json`,
`run-list.json`, `terminal-send-stale.json` (a real `terminal_handle_stale` error) and
`terminal-send-accepted.json` (a real accepted `terminal send --enter --json` receipt, with its
"no turn start was observed" warning). Ids, paths, names, prompts and messages are replaced by placeholders.

`terminal-send-truncated.txt` is synthetic: the stale-handle output cut off mid-JSON, as left by a timed-out
`terminal send` that still reported its request id.
