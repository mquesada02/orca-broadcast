# orca-broadcast

A command-line tool that sends instructions to the Claude Code agents running in Orca on this machine (pause, resume, broadcast, recover), and proves that each agent handled them.

## Language

**Broadcast record**:
The durable record of one broadcast: its text, its token, and the state of each target agent. It stays open until every target is acked, gone or abandoned.
_Avoid_: Broadcast run, message log

**Re-run**:
`broadcast` with no text, or with the open broadcast's own text: it continues that broadcast with the same token and a fresh timeout. `recover` with an open recovery record continues that record with its token in the same way.
_Avoid_: Resume (that is `resume`), retry

**Scope**:
The recorded targets that a re-run, or `close` with filters, acts on: those that match the filters and are `pending`, `acked` or `gone`. Abandoned targets are never in scope. For `recover`, the scope of a re-run is the stored recovery rows that match the filters; the other rows keep their result.
_Avoid_: Selection (that is the first choice of targets at the prompt)

**Ack**:
The proof that an agent handled a message. Any reply that ended a turn since the send, with the token line as its last line, is an ack, also when later turns follow. The command reads Orca's last reply and the Claude transcript. An ack is permanent.
_Avoid_: Receipt (a send receipt is never proof)

**No-ack**:
The reason on a pending target that replied after the send without the ack line. The target is not sent the message again, and a later ack in any end-of-turn reply still counts.
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
The saved snapshots of the live Claude agents, one file per runtime key (the pair of boot ID and Orca runtime ID), with the newest 5 kept. An entry holds a session ID, the pane key, the worktree and the role of one agent, and never prompt or reply text. `roster save`, and the start and end of `broadcast`, `pause` and `resume`, write it.
_Avoid_: Backup, agent list

**Crash mode**:
`recover` with no open pause run. It reads the roster from before the restart, shows which agents are restored, missing or failed, and after one confirmation restarts the missing agents that are not workers and prompts the agents whose last turn did not finish and the coordinators that have a missing worker.
_Avoid_: Reboot mode, recovery run

**Pause-run mode**:
`recover` with an open pause run (a planned restart). It restarts the missing agents of the run and the missing roster agents outside it, and sends no prompt, so the agents stay paused until `resume`. It writes no recovery record: the outcome of each agent, the starts, and the missing workers of each coordinator are stored in the pause run, and `resume` adds those workers to the CONTINUE message of their coordinator.
_Avoid_: Planned-restart mode, run recovery

**Recovery record**:
The durable record of one crash recovery: its token and one row per agent with its status. It is written after the confirmation and before the first start, and it closes by itself when every row is final.
_Avoid_: Recovery run, recover log

**Restored agent**:
A live Orca agent row, found in Orca's own listing of live agents, whose Claude session ID is the agent's, for an agent that `recover` did not start. The term says how the agent came back; the `restored` status is a different thing, and a restored agent that was prompted ends `acked`.
_Avoid_: Recovered agent, surviving agent

**Restarted agent**:
An agent that `recover` started with `claude --resume` and that then appeared in Orca.
_Avoid_: Respawned agent, revived agent

**Held session**:
A Claude session that no live Orca agent row has, but that a live process holds. `recover` never starts it: the row is `failed`, reason `session-held`.
_Avoid_: Locked session, busy session

**Missing agent**:
An agent of the roster whose session ID no live Orca agent row has and that no live process holds. An agent whose session may be held by a process of unknown session is not missing: it is `failed`, reason `unverifiable`.
_Avoid_: Dead agent, lost agent

**Session role**:
The role of an agent that is neither a coordinator nor a worker of an orchestration run.
_Avoid_: Standalone, solo, plain agent
