# Unreplied wake-ups and waiting for background work

Two accepted trade-offs:

- `pause` does not detect an agent that a background task woke up but that has not replied yet.
- `pause` and `broadcast` do not wait for an agent's background work to end, and they do not send again when the agent wakes. They report such an agent `background`.

## Why this is out of scope

The proofs read only Orca state and the agent's last reply:

- A confirmed agent counts as woken only when it has a newer reply whose last line is not the `ORCA-PAUSED <token>` line. State alone never wakes it. Background tasks often move an agent to `working` without any new reply, so a state-based check caused false "still-working" results in live pauses (spec #61). Before the agent replies, the tool has no signal that it woke.
- An agent with `state == "working"` and `mainAgent.state == "done"` has ended its turn while background work still runs. The spec #118 chose to report this case with the `background` reason, not to wait for it. The reason tells the user why the agent is not confirmed, and the user can run the command again later.

The specs #61, #74 and #118 already listed this as out of scope.

## Prior requests

- None.
