# orca-broadcast

A command-line tool that sends instructions to the Claude Code agents running in Orca on this machine (pause, resume, broadcast), and proves that each agent handled them.

## Language

**Broadcast record**:
The durable record of one broadcast: its text, its token, and the state of each target agent. It stays open until every target is acked, gone or abandoned.
_Avoid_: Broadcast run, message log

**Hand-over**:
The step in which `pause` stops a broadcast that is still waiting for acks, so that the pause does not wait for the broadcast's timeout.
_Avoid_: Takeover, kill, preemption

**Commit point**:
The moment the user answers "yes" to the first pause prompt (or passes `--yes`). Before it, a pause writes nothing new; from it, the pause owns the agents the broadcast was waiting for.
_Avoid_: Confirmation, point of no return

**Group**:
A saved, named filter of agents, resolved again each time it is used.
_Avoid_: Preset, list, tag

**Session role**:
The role of an agent that is neither a coordinator nor a worker of an orchestration run.
_Avoid_: Standalone, solo, plain agent
