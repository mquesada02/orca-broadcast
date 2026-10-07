# Fixtures

Redacted samples of real `orca-ide ... --json` output: `worktree-ps.json`, `terminal-list.json`,
`run-list.json`, `terminal-send-stale.json` (a real `terminal_handle_stale` error) and
`terminal-send-accepted.json` (a real accepted `terminal send --enter --json` receipt, with its
"no turn start was observed" warning). Ids, paths, names, prompts and messages are replaced by placeholders.

`terminal-send-truncated.txt` is synthetic: the stale-handle output cut off mid-JSON, as left by a timed-out
`terminal send` that still reported its request id.

`worktree-ps-woken-*.json` are redacted captures of one real Claude agent (from a throwaway terminal) that a
background `sleep` task wakes after its `ORCA-PAUSED` reply. Each file holds one agent row, in the worktree wrapper of
`worktree-ps.json`; the row itself is real except the placeholders:

- `-working-token`: the agent is `working` while the background task runs, and its last reply already ends with the token line.
- `-midturn`: after the wake-up, mid-turn, the agent is `working` and `lastAssistantMessage` is `null` (not an empty string).
- `-done-token`: the woken agent is `done` and its new reply ends with the same token line (it followed the new pause sentence).
