# Pause and resume

This page covers `pause`, `resume` and `close` of an open pause run. It explains how pause and resume work, the `--reason` presets and the reason codes.

Other pages hold the rules that several commands share:

- [How it works](how-it-works.md) holds the records, the lock, background work and the known limits.
- [Reference](reference.md) lists every option and every exit code.
- [Filters and groups](filters-and-groups.md) holds the filter rules.

For the terms on this page, see [CONTEXT.md](../../CONTEXT.md).

## Quick start

Run the commands from a plain terminal, not from inside a Claude session. An agent cannot pause itself while it runs a command.

Before you leave:

```sh
orca-broadcast pause            # lists the agents that get the message, asks "Send to N agents? [y/N]", then waits
orca-broadcast pause --timeout 3m
orca-broadcast pause --reason end-of-day   # tell the agents why you are pausing
orca-broadcast pause --repo alpha          # pause one repo
```

When you are back:

```sh
orca-broadcast resume
orca-broadcast resume --role worker        # resume only the workers
```

If a run can never finish (for example an agent ignores the message), abandon it:

```sh
orca-broadcast close
```

## How pause works

`pause` asks each working agent to finish its step, write a short note and wait. It then checks that every agent stopped.

1. `pause` lists the agents with `orca-ide worktree ps`. It selects every Claude agent in state `working` that matches your filters. See [Filters and groups](filters-and-groups.md#flag-table-per-command) for the filter flags.
2. `pause` gives each agent a role:
   - `coordinator`: its terminal is a coordinator in `orca-ide orchestration run-list`, or the parent link of another live agent points at it.
   - `worker`: it is an active row in `orca-ide orchestration worker-list`, or its parent link points at a live agent.
   - `session`: every other agent.

   A coordinator wins over a worker. The parent links come from `worktree ps`, so the roles survive an Orca restart.
3. The tables show the orchestration run IDs of each agent, or `run: unknown` when none is known. A line says `N agents have a role but no known run` when a coordinator or a worker has no known run. A session without a run is not counted. With `--json`, each agent has `orchestrationRunIds`. See [JSON output](reference.md#json-output).
4. `pause` lists the agents that will get a message and asks `Send to N agents? [y/N]`. It asks when an agent will get a message, or when a broadcast or a recovery is open. Without a terminal, `pause` refuses to send unless you pass `--yes`.
5. `pause` saves the pause run. It then sends one message, with a random token, to each agent that is not on a permission prompt. It sends to the coordinators first.
6. The message starts with `[orca-broadcast]` and gives the pause sentence of the [reason](#pause-reasons). It tells the agent to do these things:
   - Finish the step it is on, start no new step and do not commit.
   - End its turn with a short note: where it stopped, and its next step.
   - Make the last line of the reply exactly `ORCA-PAUSED <token>`.
   - If a background task or a notification wakes it before that, do not act on it: reply with one short line, and end that reply with the same last line.
   - After that, do nothing until it gets a message that starts with `[orca-broadcast] CONTINUE`.
7. A coordinator also gets the sentence "Do not dispatch new workers or tasks."
8. An agent counts as paused when all of these are true:
   - No message is still pending for it.
   - Its last reply is new since the send.
   - That reply ends with the exact line `ORCA-PAUSED <token>`.
   - Orca shows its state as `working` or `done`. Any other state, such as a permission prompt, never counts.

   A reply in the Claude transcript of the agent can also prove it, without these conditions. Any reply that ended a turn since the send, with the token line as its last line, proves the target, also when later turns follow. Text that the agent writes between tool calls never counts. An agent with no readable transcript is proven by Orca's last reply only. See [The proof](how-it-works.md#the-proof).

   Send receipts are never proof. A background task can keep Orca showing the agent as `working`. That does not matter for the proof. The table then shows the reason `background`, not `still-working`. See [Background work](how-it-works.md#background-work).
9. `pause` waits up to `--timeout`. The default is `10m`. The wait loop also adds agents that start working later and match any filter set of the run. It sends the message again once to a confirmed agent that wakes up. A second wake-up shows the reason `re-woken`. In that call, `pause` sends nothing more.

If you run `pause` in a Claude session, that session is not paused. The output shows it in a block that starts with `self (not paused)`. That block appears when the session is a Claude agent that matches your filters. If no other agent is paused, it appears only when the session is `working`. `resume` marks it resumed at once, but only when you run `resume` from that same session. See [How resume works](#how-resume-works).

`pause` also handles an open broadcast or an open recovery. See [One record at a time](how-it-works.md#one-record-at-a-time) and [Pause stops a waiting broadcast](how-it-works.md#pause-stops-a-waiting-broadcast).

If you run `pause` again before `resume`, it extends the same run. See [Records and the state folder](how-it-works.md#records-and-the-state-folder).

### The live block of pause

The wait shows the block of [the shared rules](how-it-works.md#the-live-block). The count line is `pausing… n/m confirmed · … · m:ss left`. The middle parts count the reasons of the agents, and the last part is the time left. The rows are the pending agents, each with its [reason](#reason-codes).

The agents counted are the selected agents that are not gone and not the running session. A row is pending when the pause status is `unconfirmed`. An agent whose send failed (reason `send-failed`) stays a row.

To see the run from another terminal, run [status](status.md).

### Pause output

The output groups the agents by pause status. Each row has the columns `repo`, `worktree`, `role`, `run`, `status` and `reason`.

| Group | Hint on the heading |
|---|---|
| `unconfirmed (N)` | not confirmed paused; check these agents before you leave |
| `confirmed (N)` | none |

When no pause run is open and no working agent matches your filters, `pause` prints `nothing to pause` and exits `0`. The session that runs `pause` is never counted.

## How resume works

`resume` sends `[orca-broadcast] CONTINUE` to the agents of the open pause run. It then checks that each agent moved.

1. `resume` reads the open pause run. When no pause run is open, it prints `nothing to resume` and exits `0`. This holds even when a broadcast or a recovery is open.
2. `resume` selects the agents of the run that are `pending` and match your filters. When you give a filter and no agent matches, it prints `nothing to resume` and exits `0`.
3. `resume` finds each recorded agent again. It uses the Claude session ID when the run has one. A restored session in a new pane is the same agent. See [ADR 0002](../adr/0002-agents-are-identified-across-a-restart-by-session-id.md).
   - `pause` records the session ID and the permission flag. It uses the process scan of its start roster save. So `resume` and a later `pause` on the open run take no extra scan.
   - When a record has no session ID, `resume` uses the Orca pane key. This holds for a run from before session IDs were recorded. After a real reboot, the moved agents of such a run show as `gone`.
   - `resume` also uses the pane key when no live agent holds the session ID, or when the scan fails. If a record has a session ID and the scan fails, a warning says `session IDs were not matched, because the process scan failed: agents were matched by pane key`.
   - A recorded coordinator or worker keeps its role and run IDs when Orca lists it as a session.
4. When at least one agent will get a message, `resume` lists those agents and asks `Send to N agents? [y/N]`. The new pane of an agent is saved in the run only after your yes (or `--yes`). Without a terminal, `resume` refuses to send unless you pass `--yes`.
5. `resume` sends the message. It sends to the workers and sessions first and to the coordinators last. The message is: `[orca-broadcast] CONTINUE. <continue sentence> Continue your task from the note in your last pause reply.` The continue sentence depends on the [reason](#pause-reasons) of the run.
6. To a coordinator for which `recover` stored missing workers, `resume` ends the message with a sentence that names those workers, each with its dispatch ID, and tells the coordinator to decide whether to retry them with `orca-ide orchestration worker-start --retry-of`. `resume` leaves out a worker that is live again. When none is left, the message is the same as for any agent. If the process scan failed, `resume` lists every stored worker.
7. `resume` skips an agent in any state other than `working` or `done`, such as a permission prompt. The row stays `pending` with the reason `waiting-permission`.
8. An agent counts as resumed when its Claude transcript shows the CONTINUE message as a user entry since the send, because Claude then took the message into its conversation. A wake-up turn never counts. An agent with no readable transcript counts as resumed when its state or its last reply changes after the message. If the agent was still `working`, it counts as resumed once Orca accepts the queued message. The reason is then `queued-while-working`. `resume` waits up to 60 seconds after the message for each agent that is not `working`.
9. If `resume` runs in the session of a pending agent, it marks that agent `resumed` at once with the reason `self`. The agent gets no message. This holds when `ORCA_PANE_KEY` equals the pane key of the agent. It holds even if Orca shows no row or a permission prompt for it. The session runs the command, so a CONTINUE would wait behind it. From any other session, or with an empty `ORCA_PANE_KEY`, the same row gets a CONTINUE like any agent.
10. The run closes when no agent in it is `pending`. If you run `resume` again, it acts only on the agents that are still `pending`. An agent whose CONTINUE already got proof becomes `resumed` without a new message.

### The live block of resume

The wait shows the block of [the shared rules](how-it-works.md#the-live-block). The count line is `resuming… n/m resumed`. The rows are the pending agents, each with its [reason](#reason-codes).

The agents counted are the selected agents that are not gone. A row is pending when the resume status is `pending`. An agent leaves the block when it is resumed.

To see the run from another terminal, run [status](status.md).

### Resume output

The output groups the agents by resume status. Each row has the columns `repo`, `worktree`, `role`, `run`, `status` and `reason`.

| Group | Hint on the heading |
|---|---|
| `pending (N)` | run resume again; for a waiting-permission row, first answer the permission prompt in that row's worktree |
| `gone (N)` | terminal or Claude is gone; restart these agents yourself |
| `resumed (N)` | none |

## Close an open pause run

`close` abandons a pause run that cannot finish. It sends nothing. An abandoned agent stays paused: continue it by hand.

- `close` with no filter abandons every `pending` agent of the run.
- `close` with a filter or `--group` abandons only the matching `pending` agents. See [Filters and groups](filters-and-groups.md#flag-table-per-command).
- When no agent matches, `close` prints `nothing to close` and exits `0`.
- The run closes when no agent in it is `pending`.
- `close` exits `0` when it finishes.

The output starts with `abandoned (N) - still paused — continue it by hand`. The `status` column shows the pause status. For a confirmed agent, the `reason` column says `paused and waiting for CONTINUE — run resume before close, or continue it by hand`. For an unconfirmed agent, it shows the pause reason.

## Pause reasons

`--reason` changes only the opening sentence of the pause message. It also changes the sentence after `CONTINUE.` in the continue message. Instructions, proof rules and safety rules are the same for every reason. The run saves the reason, so `resume` (which has no flag) sends the matching continue sentence.

| `--reason` | Pause sentence | Continue sentence |
|---|---|---|
| `network` | The user is leaving and the network will drop. | The network is back. |
| `away` | The user is stepping away for a while. | The user is back. |
| `end-of-day` | The user is stopping work for the day. | The user is back for a new session. |
| `limit` | The user is close to a usage or rate limit. | The limit has reset. |
| `restart` | The user will restart the PC soon, and everything in /tmp will be erased; first copy anything you still need from /tmp to a place outside it. | The PC has restarted; anything you left in /tmp is gone. |
| *(no flag)* | The user asked all agents to pause. | The user asked you to continue. |

An unknown name is a usage error (exit `2`). `--reason` on `resume`, `close`, `broadcast` or `recover` is also a usage error. `recover` also refuses `--state` and `--file`.

If you run `pause` again on an open run, it keeps the reason of the run. Give the same `--reason`, or none. A different `--reason` is refused with exit `2`, and `pause` sends nothing. Use `close` first. The message names the reason of the run:

- `This run was paused with --reason <name>; use --reason <name>, or close it first.`
- `This run was paused without --reason; run pause without --reason, or close it first.`

The `reason` column in the output tables is a different thing. It says why one agent is not confirmed or not resumed. See [Reason codes](#reason-codes).

## Reason codes

A pause row has the status `unconfirmed` or `confirmed`. A resume row has the status `pending`, `resumed` or `gone`. The `reason` column says why a row is in that status.

For a `gone` agent, the output shows the resume reason, also in the pause table.

Pause reasons:

| Reason | Meaning |
|---|---|
| `still-working` | The agent has not answered the message, or `pause` has not sent it yet. Orca shows the agent as `working`. |
| `background` | The agent has not answered. Its turn ended, and background work keeps Orca showing `working`. See [Background work](how-it-works.md#background-work). |
| `waiting-permission` | Orca shows a state other than `working` or `done`, such as a permission prompt. While the agent is in that state, `pause` does not send the message. |
| `done-no-token` | The agent is `done`, but no reply since the send ends with the `ORCA-PAUSED <token>` line. Orca's last reply is not new or does not end with it, and the transcript shows no such reply. |
| `send-failed` | Orca refused the send. `pause` does not retry in that call. A later `pause` on the open run tries again. |
| `re-woken` | A confirmed agent woke up a second time. `pause` does not send the message again in that call. A later `pause` on the open run does. |
| `self` | The agent runs `pause`. It is not paused, and its own block shows it. |

Resume reasons:

| Reason | Status | Meaning |
|---|---|---|
| `terminal-closed` | `gone` | No terminal has the pane key of the agent. |
| `terminal-orphaned` | `gone` | The terminal of the agent is orphaned. |
| `agent-missing` | `gone` | The terminal is live, but Orca lists no agent for it. |
| `agent-exited` | `gone` | The terminal no longer runs Claude. |
| `waiting-permission` | `pending` | Orca shows a state other than `working` or `done`. `resume` sent no message. |
| `send-failed` | `pending` | Orca refused the send. |
| `no-proof` | `pending` | The message was sent, but the transcript shows no CONTINUE user entry within 60 seconds. For an agent with no readable transcript: the state and the last reply did not change. |
| `queued-while-working` | `resumed` | The agent was `working`, so Orca queued the message. |
| `self` | `resumed` | The session of the agent runs `resume`, so it got no message. |

## Exit codes

`0` means no selected agent is unconfirmed (`pause`) or still pending (`resume`); `1` means at least one is; `2` is a usage error, a refusal to send (no terminal, or `--json`, without `--yes`, or your answer is no), a failed Orca listing, a `--reason` that differs from the open run, or another `orca-broadcast` that is running; `130` is an interrupt. See [Exit codes](reference.md#exit-codes).
