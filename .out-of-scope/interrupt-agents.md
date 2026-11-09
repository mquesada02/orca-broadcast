# Interrupting agents, answering permission prompts, WIP commits

orca-broadcast never sends Esc to an agent, never answers a permission prompt for the user, and never makes WIP (work in progress) commits.

## Why this is out of scope

The tool only sends messages, and each agent decides how to stop:

- A pause is graceful. The pause message asks the agent to finish the step it is on, not to start a new step and not to commit, to note where it stopped, and to wait for CONTINUE. An Esc interrupt would stop the agent in the middle of a step, which is the opposite of that goal.
- When an agent sits on a permission prompt, the tool sends nothing to it. `pause` reports it `waiting-permission`, and `resume` keeps it `pending` with the hint "run resume again; for a waiting-permission row, first answer the permission prompt in that row's worktree". So the tool never lands text in a permission dialog, and only the user answers it.
- A pause must not leave WIP commits behind (spec #14: paused agents do not commit work in progress). So the pause message tells each agent not to commit, and the tool makes no commits itself.

The spec #14 already listed this as out of scope. The map #2 already ruled out Esc interrupts.

## Prior requests

- None.
