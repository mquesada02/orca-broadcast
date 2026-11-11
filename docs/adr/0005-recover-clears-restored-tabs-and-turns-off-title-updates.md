# `recover` clears restored tabs with `close --all` and turns off Claude Code's title updates

After a PC restart, Orca restores the tabs of each worktree, but no agent runs in them. `recover` starts each missing agent in a new tab, so the user saw a dead tab beside every new one. The new tab also lost the title that the user gave the old tab, and Claude Code repaints the tab title by itself. The research notes [docs/research/restored-tabs.md](../research/restored-tabs.md) and [docs/research/tab-title.md](../research/tab-title.md) hold the facts behind both choices.

**Clear by `close --all`.** Restored tabs keep their IDs, but the Orca CLI cannot see them. Every command that acts on one tab needs a runtime handle, and a restored tab has none. `terminal create` and `agent launch` always make a new tab. The only command that reaches a restored tab is `terminal close --worktree path:<path> --all`, which removes every tab, layout and resume record of the worktree. So `recover` runs it right before the first start in a worktree. It runs it only when a fresh listing shows no terminal row in that worktree (an orphaned row counts as a live terminal), and at most once per worktree and run. A worktree with a live terminal is never cleared. The confirmation lists the worktrees that may be cleared, and `--keep-tabs` turns the clear off.

**Title updates off.** The roster saves the layout title of each agent's tab. When `recover` restarts an agent that has a saved title, it opens the tab with that title and sets `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` in the command that runs `claude --resume`. This is the way that Claude Code documents to stop its title updates. An agent with no saved title gets the label `<repo>/<worktree> (recovered)` and keeps the title updates on.

## Considered options

- **Resume the agent inside the restored tab.** Rejected: every command that writes to a tab needs a live handle, and a restored tab has none.
- **Close the restored tab after the new start.** Rejected: closing one tab needs a handle, and `close --all` after the start would also stop the new agent.
- **Rename the tab after the start with `terminal rename`.** Rejected for now: nobody verified that a custom tab title beats a title that the running program sets. The variable removes the writer, so it needs no such rule.
- **Ask Orca for a feature and wait.** Rejected as the only path: it would leave the duplicate tabs until Orca ships it.

## Consequences

- The clear loses the scrollback and the Orca resume records of the cleared tabs. A restored tab that Orca could have revived is also removed. `--keep-tabs` keeps them.
- For a titled restart, Claude Code writes no generated session title and sends no status reports to the terminal.
- A failed clear is a warning. The start goes on, and only the duplicate tab stays.
- Some points are not verified, and the choice accepts them as risks: whether a custom tab title beats a program title, the effect of the variable on the later `/resume` picker, whether an untitled tab has an empty layout title (if Orca fills it with an automatic title, `recover` saves and restores that title), and whether opening the worktree in Orca, its Restart chip or a sleep-resume revives a restored tab after a reboot.
