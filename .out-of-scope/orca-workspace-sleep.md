# Orca's workspace Sleep

orca-broadcast does not use Orca's UI workspace Sleep to pause agents.

## Why this is out of scope

Workspace Sleep is an action in the Orca UI. The `orca-ide` CLI cannot start it, so the tool cannot script it. The tool pauses agents with a message instead, which also lets each agent finish the step it is on and note where it stopped first.

The map #2 and the spec #14 already listed this as out of scope.

## Prior requests

- None.
