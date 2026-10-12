# Non-Claude agents

orca-broadcast targets only Claude Code agents. Codex, OMP, Pi, Grok and other agent types that Orca can run are ignored by `pause`, `resume` and `broadcast`.

## Why this is out of scope

The whole protocol depends on how Claude Code behaves in an Orca terminal:

- The pause and ack proofs read the agent's last reply (`lastAssistantMessage` in `orca-ide worktree ps`) and look for a token such as `ORCA-PAUSED <token>` or `ORCA-ACK <token>`.
- The tool decides whether a send is safe from the agent's state (`working`, `done`, `waiting`) as Orca reports it for Claude Code.
- The research behind the send path (TUI send behaviour, terminal identity, coordinator behaviour) was done only for Claude Code.

Each other agent type would need its own research on these three points, its own fixtures from real `orca-ide` output, and its own proof rules. The maintainer runs only Claude Code agents, so this cost buys nothing today.

The specs #14 and #61 already listed this as out of scope.

## Prior requests

- #97 — "Support non-Claude agents"
