# Interrupting agents, answering permission prompts, WIP commits

orca-broadcast never sends Esc to an agent, never answers a permission prompt for the user, and never makes WIP (work in progress) commits.

## Why this is out of scope

The tool only sends messages, and each agent decides how to stop:

- A pause is graceful. The pause message asks the agent to finish its current step, save its work, note where it stopped and wait for CONTINUE. An Esc interrupt would stop the agent in the middle of a step, which is the opposite of that goal.
- When an agent sits on a permission prompt, the tool sends nothing to it. `pause` reports it `waiting-permission`, and `resume` keeps it `pending` with the hint "answer the permission prompt in <worktree>, then run resume again". So the tool never lands text in a permission dialog, and only the user answers it.
- Saving work, including any commit, is the agent's own job inside its worktree. The tool does not write to any repository.

The map #2 and the spec #14 already listed this as out of scope.

## Prior requests

- None.
