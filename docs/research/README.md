# Research notes

These notes are dated snapshots of live observations. They informed design decisions at the time. Orca and Claude Code can change after a note is written.

The guide pages in `docs/guide/` and the ADRs in `docs/adr/` are the current truth. Do not take an old note as the current behaviour of the tool.

| Note | Topic |
|---|---|
| [agent-filter-fields.md](agent-filter-fields.md) | Which Orca fields identify an agent's repo, worktree, role and run |
| [agent-restart.md](agent-restart.md) | How to restart an agent that did not come back |
| [background-shell-state.md](background-shell-state.md) | Background-shell agent state in Orca |
| [coordinator-stop.md](coordinator-stop.md) | How an Orca coordinator behaves when its workers stop |
| [live-status-records.md](live-status-records.md) | What per-target state each command saves to its record while it waits |
| [multiline-send.md](multiline-send.md) | Multi-line text in `orca-ide terminal send` |
| [pre-crash-roster.md](pre-crash-roster.md) | Where to find the agents that were alive before a crash |
| [reply-source.md](reply-source.md) | Where to read every reply since a send |
| [restart-identity.md](restart-identity.md) | Which identity links a restored session to its old agent |
| [restored-tabs.md](restored-tabs.md) | What the Orca CLI sees and does with tabs that Orca restores after a reboot |
| [tab-title.md](tab-title.md) | What decides a recovered tab's title, and whether it can be kept or set again |
| [terminal-identity.md](terminal-identity.md) | How the CLI identifies one agent's terminal reliably |
| [terminal-redraw.md](terminal-redraw.md) | How to redraw a multi-line block on stderr in place, and clear it |
| [tui-send.md](tui-send.md) | `orca-ide terminal send` to a Claude Code TUI that is mid-turn |
