# Recover

After a PC restart or an Orca crash, every Claude Code process is gone. Orca restores only some sessions, in new panes.

`recover` finds the agents that were alive before the restart. It shows which of them came back. After your confirmation, it restarts the missing agents and tells each interrupted agent to continue.

The terms on this page are defined in [CONTEXT.md](../../CONTEXT.md).

Run `recover` from a plain terminal, not from inside a Claude session.
## Modes

`recover` has two modes:

| Mode | When | What it does |
|---|---|---|
| Crash mode | No pause run is open. | Restarts the missing agents, then sends the continue prompt. |
| Pause-run mode | A pause run is open (a planned restart). | Restarts the missing agents. Sends no prompt. Writes no recovery record. See [Pause-run mode](#pause-run-mode). |

Most of this page describes crash mode.

## Example

```sh
orca-broadcast recover            # shows the report, asks once if anything is due, then restarts and prompts
orca-broadcast recover --timeout 5m
orca-broadcast recover --keep-tabs   # do not clear the restored tabs
orca-broadcast recover --yes      # no question; needed without a terminal
orca-broadcast recover --repo alpha --role coordinator   # only part of the fleet
```

## Options of recover

| Option | Effect on `recover` |
|---|---|
| `--timeout <n>s\|m\|h` | Limits the whole command. Default `10m`. See [Time](#time). |
| `--yes` | Skips the question. Without a terminal, `recover` refuses to run unless you pass it. |
| `--json` | Prints one JSON object. It never asks, so it needs `--yes`. See [Output](#output). |
| `--keep-tabs` | Turns off the clear of restored tabs. `recover` then clears no worktree, and the confirmation lists none. See [Restored tabs and titles](#restored-tabs-and-titles). |
| `--group <name>` | Selects the part of the fleet to recover. Repeat it for a union of groups. |
| `--repo`, `--worktree`, `--role`, `--run` | Select the part of the fleet to recover. |

`recover` refuses `--state`, `--file` and `--reason` with exit `2`. Every other option that `recover` does not take also exits `2`, unless `--help` is also given.

For the full definition of each option, see [Options](reference.md#options). For how filters and groups combine, see [Filters](filters-and-groups.md#filters) and [Groups](filters-and-groups.md#groups).

## What recover reads

`recover` reads the roster. The roster holds saved snapshots of the live Claude agents, one file per Orca runtime. `roster save` writes it, and so do other commands.

1. `recover` takes the newest snapshot of an earlier runtime.
2. While the runtime of the last snapshot used lived less than one hour, `recover` adds the next older snapshot of an earlier runtime. This covers a chain of quick restarts.
3. The entries merge by session ID. The newer entry wins.
4. If no snapshot of an earlier runtime exists, `recover` uses the snapshot of the live runtime. It then warns `no snapshot from before the restart; using the live runtime's snapshot (best effort)`.

The report starts with one line for each snapshot used, with its age.

The design relies on Orca changing its runtime ID at every Orca start. The tool does not test whether Orca keeps the runtime ID after a crash of Orca alone. If Orca keeps it, a save after the crash writes to the same file as before. Only a new boot ID (a PC restart) then protects the earlier snapshot.
## How recover matches agents

`recover` matches each agent to a live Orca agent by its Claude session ID. It never matches by pane key alone.

| Standing | Meaning |
|---|---|
| Restored | A live Orca agent has the session. |
| Missing | No live Orca agent has the session, and no live process holds it. |
| Held | No live Orca agent has the session, but a live process holds it. |
| Unverifiable | A process of unknown session may hold the session. |

For a held session, `recover` checks again for up to 60 seconds. If `--timeout` leaves less time, it checks for that time only. If the session is still held, the row is `failed` with reason `session-held`.

An unverifiable session is `failed` with reason `unverifiable`.

## The report

The report has one row for each agent. The columns are `repo`, `worktree`, `role`, `status` and `reason`. Coordinators come first.

The session that runs `recover` is never a row. It has its own block. When that session is a coordinator, the block lists its missing workers.

After the table, `recover` prints one line `cleared <repo>/<worktree>` for each worktree that it cleared. See [Output](#output).

## The confirmation

If a restart, a prompt or a worker list is due, `recover` lists what it will `restart`, `prompt` and `leave` to coordinators. Then it asks once:

```
Restart N agents, prompt N and leave N workers to their coordinators? [y/N]
```

For each restart, the list shows the saved permission flag of the agent, or `no permission flag`. `--yes` skips the question. If nothing is due, `recover` asks nothing.

After the restart, prompt and leave lines, and before the question line, the list names the worktrees that `recover` may clear. It starts with this line:

```
Each worktree below is cleared (its restored tabs are closed) only if it still has no live terminal when its first agent starts:
```

Then it prints one line `clear <repo>/<worktree>` for each worktree. The names are those of the first restart in that worktree. A worktree is listed when a planned restart is in it and the listing taken before the question has no terminal row there. The list is not a promise: `recover` checks again at the start. With `--keep-tabs` the list is empty, and the line is not printed. See [Restored tabs and titles](#restored-tabs-and-titles).

If you answer no, `recover` does these things:

- It starts nothing.
- It sends nothing.
- It writes no recovery record.
- It prints the report. Each row that a restart, a prompt or a worker list would have handled shows `pending` with reason `declined`.
- It exits `1`.

## What happens after you answer yes

1. `recover` writes the recovery record.
2. `recover` restarts each missing agent that is not a worker. Coordinators go first.
3. `recover` checks Orca at short intervals. It waits for each restarted agent to appear in Orca.
4. In the same checks, `recover` sends the continue prompt to each agent that is due one, as soon as that agent is live. An agent that came back by itself gets it at once. Coordinators go first within each check.
5. `recover` keeps checking until each prompted agent has acked or has another result, or until the time limit ends.

A restart opens a new terminal in the worktree of the agent. If the worktree has no terminal, `recover` first clears it. See [Restored tabs and titles](#restored-tabs-and-titles). The terminal runs this command when the agent has no saved tab title:

```sh
env -u CLAUDE_CODE_RESUME_INTERRUPTED_TURN claude --resume <session id>
```

It runs this command when the agent has a saved tab title:

```sh
env -u CLAUDE_CODE_RESUME_INTERRUPTED_TURN CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude --resume <session id>
```

Both commands also get the saved permission flag of the agent, if it has one. `recover` starts a session only when no live process holds it.

## Restored tabs and titles

After a PC restart, Orca restores the tabs of each worktree, but no agent runs in them. The Orca CLI cannot see these tabs and cannot close one of them alone. Without a clear, the user would see the dead tab beside the new one. [ADR 0005](../adr/0005-recover-clears-restored-tabs-and-turns-off-title-updates.md) records the choice.

### The clear

Before the first start in a worktree, `recover` takes a fresh listing of the terminals. A live terminal is any terminal row of the listing in that worktree, an orphaned row included. A worktree is identified by its path, compared as an exact string.

1. If the worktree has no live terminal, `recover` clears it with Orca's `terminal close --worktree path:<path> --all`. Then it starts the agent.
2. If the worktree has a live terminal, `recover` does not clear it. It starts the agent.
3. `recover` considers a worktree at most once per run. A second agent in the same worktree never causes a clear, so the first new tab stays.
4. A failed clear adds a warning, and the start goes on. `recover` does not try that worktree again in the run.

Other rules:

- `recover` clears only a worktree where it starts an agent. Restored tabs in other worktrees stay.
- A re-run clears only a worktree that still has no live terminal. A worktree where an earlier run started an agent has one, so it is not cleared again.
- Pause-run mode clears in the same way.
- A clear removes the tabs of the worktree, their scrollback and their Orca resume records. Use `--keep-tabs` to keep them. Then `recover` clears nothing and the confirmation lists no worktree.

### The tab title

The roster saves the title of the tab of each agent. See [What the roster holds](roster.md#what-the-roster-holds).

- An agent with a saved title gets a new tab with that title. `recover` starts it with `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, so Claude Code does not change the title.
- An agent with no saved title gets a tab with the label `<repo>/<worktree> (recovered)`. Claude Code's title updates stay on, so Claude Code may name the tab.
- `--keep-tabs` does not change the title rules.

The variable has a cost: Claude Code writes no generated session title and sends no status reports to the terminal for that agent. See [ADR 0005](../adr/0005-recover-clears-restored-tabs-and-turns-off-title-updates.md).

## Who gets the continue prompt

An agent is due the continue prompt in these cases:

- Its last saved state was `working` or `waiting`.
- It is a coordinator that has a missing worker to list. Its last saved state does not matter.

This holds whether the agent came back by itself or `recover` restarted it. `recover` never sends the prompt to an agent on a permission prompt.

The proof rule is the token line. An agent counts as acked when its reply ends with this exact last line:

```
ORCA-ACK <token>
```

Any reply that ended a turn since the send, with the token line as its last line, proves the target, also when later turns follow. `recover` reads Orca's last reply and the Claude transcript of the agent. Text that the agent writes between tool calls never counts. An agent with no readable transcript is proven by Orca's last reply only. See [The proof](how-it-works.md#the-proof).

## Workers

`recover` never restarts a worker.

The continue prompt of a coordinator names its missing workers. Each worker has its dispatch ID. The prompt tells the coordinator to decide whether to retry them with `orca-ide orchestration worker-start --retry-of`.

A worker whose coordinator does not get this list shows `no-coordinator`.

## Time

`--timeout` limits the whole command from its start. The default is `10m`. The time that the question waits does not count.

## Statuses

| Status | Meaning |
|---|---|
| `restored` | A live agent has the session, and no prompt is due. |
| `restarted` | `recover` started it, and no prompt is due. |
| `acked` | It got the continue prompt, and its reply ended with the ack line. |
| `pending` | Not finished. The reason says why. See the table below. |
| `gone` | Its terminal or agent went away. |
| `left-to-coordinator` | The list of the missing workers was sent to the coordinator. This does not mean that the workers were restarted. The coordinator decides. |
| `no-coordinator` | A missing worker whose coordinator did not get the list. See the table below. |
| `failed` | `recover` could not restart it. See the table below. |
| `abandoned` | `close` abandoned it (reason `closed`), or `pause` abandoned it (reason `paused`). See [Close an open recovery](#close-an-open-recovery). |

### Reasons of a pending row

| Reason | Meaning |
|---|---|
| `declined` | You answered no. |
| `timed-out` | `recover` did not handle it before `--timeout` ended. |
| `awaiting-start` | It was started, and it is not yet in Orca. |
| `waiting-permission` | It is on a permission prompt, so no prompt was sent. |
| `send-failed` | Orca refused the send. |
| `no-ack` | It replied without the ack line. A later ack still counts. |
| `still-working` | It is still on its turn. |
| `background` | Its turn ended and background work runs. See [Background work](how-it-works.md#background-work). |

### Reasons of a no-coordinator row

Retry the worker yourself.

| Reason | Meaning |
|---|---|
| `coordinator-missing` | The coordinator is missing, or it did not get the list. Its restart failed, it is on a permission prompt, or its prompt was held back or failed. |
| `coordinator-filtered` | The coordinator is outside your filters. |
| `coordinator-is-self` | The coordinator is the session that runs `recover`. The block of that session lists the worker. |
| `coordinator-not-paused` | Pause-run mode only. The coordinator is not in the pause run. |

### Reasons of a failed row

| Reason | Meaning |
|---|---|
| `session-held` | A live process holds the session. |
| `unverifiable` | A process of unknown session may hold the session. |
| `scan-failed` | A scan of the Claude processes failed. No further agent was started, or a started agent could not be seen. |
| `did-not-appear` | `recover` started it, but it never appeared. |
| `no-transcript` | The worktree has no transcript of the session. |
| `invalid-session-id` | The saved session ID is not valid. |
| `flag-not-allowed` | The saved permission flag is not one that `recover` accepts. |
| `start-failed` | Orca could not create the terminal. |

### When the recovery record closes

An agent that is due a prompt never ends `restored` or `restarted`. It ends `acked`, `pending`, `gone` or `failed`.

The recovery record closes by itself when every row is final. These rows are final:

- `acked`, `gone`, `left-to-coordinator`, `failed` and `abandoned`.
- `restored` and `restarted`, because no prompt is due.
- `no-coordinator`, once its coordinator is no longer `pending`.

A `pending` row is never final.

## Output

`recover` prints the table of rows. With `--json`, it prints one object with the fields `rows`, `snapshots`, `cleared` and `record`, and the usual `warnings`. The field `record` holds the recovery record, or `null`. See [JSON output](reference.md#json-output).

The text report prints one line `cleared <repo>/<worktree>` for each worktree that this run cleared. The lines come after the table and before the block of the session that runs `recover`. A worktree whose clear failed is not listed. Its failure is a warning.

The JSON key `cleared` is a list of `{ "repo", "worktree" }`. It is `[]` when nothing was cleared, when you answered no, and when there is nothing to recover. It is also in the error object of a `recover` run. A call that fails before the command name is set prints the other shape, which has no `cleared`. See [JSON output](reference.md#json-output).

In crash mode, the recovery record has a field `cleared` with every clear of its recovery. A re-run appends its own clears to the same record. The report and the top-level `cleared` hold only the clears of that run. Pause-run mode writes no record, so only the report and the top-level `cleared` hold the list.

Exit codes: `0` when no row is `pending`, `gone`, `no-coordinator` or `failed`. `1` when a row is one of these, or when you answer no. `2` on a refusal. See [Exit codes](reference.md#exit-codes) for all cases, including `130` for an interrupt.

## Safety

`recover` restarts a session only after your yes, or `--yes`. It never restarts a session that a live process holds. It never restarts a worker. It never sends to an agent on a permission prompt. It never clears a worktree that has a live terminal.

`recover` holds the lock while it waits. See [The lock](how-it-works.md#the-lock).

## Manual check

The restart command (see [What happens after you answer yes](#what-happens-after-you-answer-yes)) was checked by hand on a throwaway session before the first live use. The resumed agent showed its old conversation and started no turn by itself. No test runs this command. Tests use a fake Orca and a fixture of the process folder.

## Close an open recovery

`close` abandons an open recovery. Every row that is not final becomes `abandoned` with reason `closed`. A row that has a result keeps it.

`close` with filters or `--group` narrows the rows by the identity saved in the record.

`close` prints `closed recovery <id>` or `recovery <id> stays open`. Then it prints the table of the rows. With `--json`, the recovery record is in `record`.

```sh
orca-broadcast close                  # abandon the open recovery
orca-broadcast close --repo alpha     # abandon only the rows of the repo alpha
```

A recovery and a broadcast that are open together are a broken state. See [One record at a time](how-it-works.md#one-record-at-a-time).

## Pause-run mode

`recover` runs in pause-run mode when a pause run is open. This is a planned restart.

1. `recover` restarts the missing agents of the run. It also restarts the missing roster agents outside the run.
2. `recover` sends no prompt and writes no recovery record.
3. `recover` stores the outcome of each agent in the run. It also stores the missing workers of each coordinator.
4. The agents stay paused until you run `resume`.
5. `resume` adds the workers that are not live again to the CONTINUE message of their coordinator.

Two rows have special reasons in this mode:

- A restarted agent that was not in the run, and that was working or waiting, shows reason `not-in-run`. `resume` does not continue it.
- A worker whose coordinator is not in the run shows `no-coordinator` with reason `coordinator-not-paused`.

A later `recover` on the same run takes again only the rows that are `failed`, `no-coordinator` or `pending`.

```sh
orca-broadcast pause --reason restart   # before you restart the PC
orca-broadcast recover                  # after the restart: restarts the missing agents
orca-broadcast resume                   # continues the agents
```
