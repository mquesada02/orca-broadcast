# orca-broadcast

A command-line tool that sends instructions to the Claude Code agents running in Orca on this machine (pause, resume, broadcast), and proves that each agent handled them.

## Language

**Broadcast record**:
The durable record of one broadcast: its text, its token, and the state of each target agent. It stays open until every target is acked, gone or abandoned.
_Avoid_: Broadcast run, message log

**Re-run**:
`broadcast` with no text, or with the open broadcast's own text: it continues that broadcast with the same token and a fresh timeout.
_Avoid_: Resume (that is `resume`), retry

**Scope**:
The recorded targets that a re-run, or `close` with filters, acts on: those that match the filters and are `pending`, `acked` or `gone`. Abandoned targets are never in scope.
_Avoid_: Selection (that is the first choice of targets at the prompt)

**No-ack**:
The reason on a pending target that replied after the send without the ack line. The target is not sent the message again, and a later ack still counts.
_Avoid_: Failed ack, nack

**Hand-over**:
The step in which `pause` stops a broadcast that is still waiting for acks, so that the pause does not wait for the broadcast's timeout.
_Avoid_: Takeover, kill, preemption

**Commit point**:
The moment the user answers "yes" to the first pause prompt (or passes `--yes`). Before it, a pause writes nothing new; from it, the pause owns the agents the broadcast was waiting for.
_Avoid_: Confirmation, point of no return

**Group**:
A saved, named filter of agents, resolved again each time it is used.
_Avoid_: Preset, list, tag

**Roster**:
The saved snapshots of the live Claude agents, one file per runtime key (the pair of boot ID and Orca runtime ID), with the newest 5 kept. An entry holds a session ID, the pane key, the worktree and the role of one agent, and never prompt or reply text.
_Avoid_: Backup, agent list

**Session role**:
The role of an agent that is neither a coordinator nor a worker of an orchestration run.
_Avoid_: Standalone, solo, plain agent
