# Agents are identified across a restart by Claude session ID, not `paneKey`

A restart of the PC or of Orca gives every restored Claude session a new `paneKey`, so a record keyed on `paneKey` loses its agent. A Claude session ID stays the same when the session is resumed, so a pause run records the session ID of each agent. `resume` and a later `pause` on the open run look for a recorded agent by its session ID in the live agents, using the scan that the start save of the command already took. When a live agent holds the ID in another pane, the command moves the record to that pane in memory and writes it only after the user's yes.

A `paneKey` still has two jobs. It joins a live Orca row to its scan record (the process that runs in that pane), and it finds the agent of a run that has no session ID. A record whose session ID no live agent holds is found by `paneKey`, because the scan can miss a live process.

## Considered options

- **Keep `paneKey` and relabel the records after a restart.** Rejected: nothing in a restart links an old `paneKey` to a new one.
- **Key on the terminal handle.** Rejected: handles go stale on a restart, and AGENTS.md already forbids keying on them.
- **Key on the worktree path.** Rejected: two agents can run in one worktree, and a worktree path says nothing about which session an agent is.

## Consequences

- The scan reads `/proc`, so the matching works on Linux only. Where the scan fails, the commands fall back to `paneKey` and add a warning.
- A run from before this change has no session IDs and keeps the `paneKey` behaviour.
- A `gone` record is never matched again within its run, as before.
- A recorded coordinator or worker that is live in a restored terminal reads as `session`, because Orca's run and worker lists hold stale handles. The records therefore keep their recorded role and run ids when the live role is `session`.
