# Fixtures

Redacted samples of real `orca-ide ... --json` output: `worktree-ps.json`, `terminal-list.json`,
`run-list.json` and `terminal-send-stale.json` (a real `terminal_handle_stale` error).
Ids, paths, names, prompts and messages are replaced by placeholders.

`terminal-send-accepted.json` is synthetic. A real accepted send would type into a live agent
terminal, so its shape is taken from the receipt recorded in the Orca research notes for the
terminal send behaviour (`stages`, `provider`, `accepted: true`).
