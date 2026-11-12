# How it works

This page holds the rules that several commands share. Each command page keeps the rules of its own command.

For the terms on this page, see [CONTEXT.md](../../CONTEXT.md).

## Records and the state folder

The tool keeps its state in `$XDG_STATE_HOME/orca-broadcast/`. The default is `~/.local/state/orca-broadcast/`.

| Entry | What it holds |
|---|---|
| `lock` | The lock file. See "The lock". |
| `current` | A JSON pointer to the one open record: `{"kind": "pause" \| "broadcast" \| "recovery", "id": "<id>"}`. |
| `pauses/` | One JSON file per pause run. |
| `broadcasts/` | One JSON file per broadcast. |
| `recoveries/` | One JSON file per crash recovery. |
| `roster/` | One JSON file per Orca runtime. The tool keeps the newest 5. |

The tool writes each record atomically before every send.

At most one record, of any kind, is open. The one exception is a recovery that is open beside a broadcast. See "One record at a time".

If you run `pause` again before `resume`, it extends the same run.

### The save stamp

Every save of a pause run, a broadcast record and a recovery record adds a `savedAt` field to the file. It holds the ISO time of the save. The tool adds it to the copy that it writes, not to the record in memory. So the record in the `--json` output of the other commands has no `savedAt` key. An older record has no stamp.

The rows of a recovery are a different case. Each row keeps its own `savedAt`, the time of the roster save that wrote that entry. `recover --json` and `close --json` still show it.

[Status](status.md) shows the age of the stamp, so that you can tell fresh data from stale data.

## One record at a time

A command may find an open record of another kind. The table shows what each command does then. For `close`, the table shows plain `close`, without filters.

| Command | A pause run is open | A broadcast is open | A recovery is open |
|---|---|---|---|
| `broadcast` | Refused, exit `2`: `A pause run is open; resume or close it first.` | With no text, or with the same text, it continues that broadcast (a re-run). A different text is refused, exit `2`: `A broadcast is open; run broadcast with no text to keep waiting, or close it first.` | Refused, exit `2`: `a recovery is open; re-run recover or close it` |
| `resume` | It resumes the run. | `nothing to resume` | `nothing to resume` |
| `pause` | It extends the run. | It stops the broadcast. See "Pause stops a waiting broadcast". | At the commit point, it abandons the recovery (reason `paused`). It prints one warning line if the recovery had a row that was not final: `recovery <id> was closed by this pause: <N> agents were not recovered yet and will not be waited for`. |
| `recover` | It runs in pause-run mode. | Refused, exit `2`: ``a broadcast is still open; run `orca-broadcast close` and then `recover` again`` | It continues that recovery (a re-run). |
| `close` | It abandons the run. | It abandons the pending targets. | It abandons every row that is not final (reason `closed`). |

`nothing to resume` means that `resume` finds no pause run to resume. It exits `0`.

### The broken state

A recovery and a broadcast can be open together. This is a broken state. It has these rules:

- Both records stay open.
- Every command that loads records, except `recover`, prints this line: `recovery <id> and broadcast <id> are both open; run orca-broadcast close to abandon both`.
- `current` points to the newer record. On a tie, it points to the recovery.
- `broadcast` and `recover` refuse and exit `2`. The `recover` message is ``a recovery and a broadcast are both open; run `orca-broadcast close` and then `recover` again``.
- `pause` abandons both records.
- `close` without filters abandons both. It prints `closed recovery <id>` and `closed broadcast <id>`.
- `close` with filters or `--group` refuses and exits `2`: ``a recovery and a broadcast are both open; run `orca-broadcast close` without filters``.

### A crash beside a pause run

A crash between two writes can leave a pause run open beside a broadcast or a recovery. Every command that loads records then abandons that record and prints a line on stderr:

| Open beside the pause run | Reason | Line |
|---|---|---|
| A broadcast | `paused` | `broadcast <id> was open beside a pause run and is now abandoned` |
| A recovery | `paused` | `recovery <id> was open beside a pause run; abandoned` |

Under `--json`, these lines go to the `warnings` field.

### Several records of one kind

If a crash leaves several records of one kind open, the newest wins. The tool leaves the others as they are and reports them. For example: `other broadcasts are open and were left as they are: <id>`.

## The lock

One lock covers `broadcast`, `pause`, `resume`, `close` and `recover`. Each command holds it for its whole run. Two runs cannot overlap.

A second command fails at once with `another orca-broadcast is running`. The `group` commands, `roster save` and `status` take no lock.

The one exception is the hand-over. In the hand-over, `pause` stops a broadcast that it has proven to be the lock owner. See "Pause stops a waiting broadcast".

There is no hand-over from `recover`. While `recover` waits for restarts and acks, `pause` and `close` refuse with `another orca-broadcast is running`. They refuse until `recover` ends or you interrupt it. To interrupt it, press Ctrl-C in its terminal. [ADR 0003](../adr/0003-recover-holds-the-lock-with-no-hand-over.md) says why.

A stopped recovery stays open with no pid. `pause` or `close` then abandons it.

### Stale lock

The `lock` file holds the pid and the start time of its owner. The next command takes the lock over when the lock is stale. A lock is stale in two cases:

1. The pid is dead.
2. The pid is alive, but it has a different start time. The system has reused the pid.

If a start time is missing, only the pid test applies.

### Takeover file

A command that takes over a stale lock first creates the file `lock.takeover`. If that file already exists, the command refuses to start. The tool never removes a leftover `lock.takeover` file by itself.

The tool also never removes a `lock` file that does not hold a pid (and optionally a start time). The command refuses to start in that case too.

In both cases the message names the file to delete:

```
another orca-broadcast is running (if none is, delete <file>)
```

## Pause stops a waiting broadcast

A `broadcast` that waits for acks in another terminal holds the lock. `pause` does not wait for it. It stops the broadcast in these steps:

1. `pause` checks its arguments before it takes the lock. With filters or `--group`, it resolves their values with read-only calls to Orca. A typo in a filter value fails with exit `2` before any broadcast is stopped.

   Next, `pause` tries to take the lock. If the lock is held, the hand-over starts only when all of these are true:
   - No pause run is open.
   - The lock file holds a start time.
   - The open broadcast record names the same pid and the same start time as the lock file.
   - That process is alive now, with that start time.

   Then `pause` reads fresh listings. If they select no agent, `pause` prints `nothing to pause` and exits `0`. It sends no signal, and the broadcast keeps waiting.

   Otherwise, `pause` checks the start time again. It then sends SIGTERM to the process and waits up to 5 seconds for the lock. The broadcast treats SIGTERM like Ctrl-C. It saves its record, clears its pid and exits `130`.
2. In these cases `pause` exits `2`:

   | Case | Message |
   |---|---|
   | Another process holds the lock, or the pid or start time does not match, or a pause run is open | `another orca-broadcast is running` |
   | The start time of the process changed before the signal | `the lock owner (pid <pid>) changed; no signal was sent` |
   | The system does not allow the signal (EPERM) | `not allowed to stop the broadcast (pid <pid>)` |
   | The lock is still held after 5 seconds | `the broadcast (pid <pid>) did not stop within 5 s` |
   | A different process takes the lock while `pause` waits | `another orca-broadcast is running` |

   `pause` sends no signal in the first case, the second case and the EPERM case. A process that is already gone (ESRCH) is not an error. `pause` then waits for the lock as usual.
3. With an open broadcast, `pause` always shows its first prompt. Your "yes" (or `--yes`) is the commit point. At the commit point, `pause` does these things in this order:
   1. It writes its run.
   2. It abandons the unacked targets of the broadcast (reason `paused`) and closes the broadcast.
   3. It prints one warning line on stderr: `broadcast <id> was closed by this pause: <N> agents had not acknowledged it and will not be waited for`. For one agent, the text says `1 agent`. Under `--json`, the line goes to the `warnings` field.

   If you decline, or an interrupt or an error comes before the commit point, the broadcast stays open. It is stopped and has no pid. `close` abandons it. `broadcast` with no text continues it.
4. A pause run, a broadcast and a recovery can also be open together after a crash. "One record at a time" has these cases.

## The live block

While `broadcast`, `pause`, `resume` or `recover` waits, it shows a block on stderr. The block lists the targets that are still pending. It replaces the single count line of the older versions. `recover` showed no progress before.

The block follows these rules:

- It draws only on a terminal (stderr is a TTY) and without `--json`. Without a terminal, or with `--json`, nothing changes. A `!` command in Claude Code has no terminal, so use [status](status.md) there.
- Line 1 is the count line of the command. After it comes one row per pending target: `<repo>/<worktree>`, the role and the reason. The rows are sorted by repo, then worktree, then role. The columns are aligned and a row has a two-space indent. An empty reason prints nothing.
- The block redraws at each poll of the wait, while the command waits. A `recover` that starts no agent and has no row to wait for draws no block. A target leaves the block when it is done, so the block gets shorter.
- The block fits the terminal. The command reads the size of the terminal at each redraw. The usable lines are the terminal rows minus 1. When the pending rows do not fit, the block shows as many rows as fit, then `… and N more`. N is the number of rows not shown. Under 3 usable lines, or when the size is unknown or 0, the block is the count line alone. Each line is cut to the terminal width minus 1 characters, so a line never wraps.
- The command clears the block before a confirm prompt and before the final report. It also clears it when you press Ctrl-C, or when SIGTERM or SIGHUP stops the command.
- The block does not hide the cursor.

The count line and the pending rule of each command are on its own page:

- [broadcast](broadcast.md#the-live-block)
- [pause](pause-and-resume.md#the-live-block-of-pause)
- [resume](pause-and-resume.md#the-live-block-of-resume)
- [recover](recover.md#the-live-block)

The block was not tried on every terminal. How a terminal re-wraps lines after you resize the window depends on the terminal.

## The proof

`broadcast`, `recover` and `pause` prove a target with a token line. A target is proven in either of these cases:

- Orca's last reply for the agent is new since the send, and its last line is the token line.
- The Claude transcript of the agent shows a reply that ended a turn since the send, with the token line as its last line. This holds also when later turns follow. A wake-up turn after the ack reply does not hide it.

Text that the agent writes between tool calls never counts, because it is not a reply that ended a turn. The proof is permanent: once a command has found it, a later change, clearing or deletion of the transcript does not undo it.

An agent with no readable transcript is proven by Orca's last reply only. This also holds when the agent ran `/clear` or forked after the send, because the transcript file of the old session is then no longer read. `resume` has its own rule: see [How resume works](pause-and-resume.md#how-resume-works). [ADR 0004](../adr/0004-the-proof-reads-the-claude-transcript.md) says why the tool reads the transcript.

## Background work

Orca keeps an agent in state `working` after its turn ends while background work runs. An example is a background shell. The `worktree ps` row of such an agent has `state: "working"` and `mainAgent.state: "done"`.

`broadcast`, `pause` and `recover` show a pending agent in that state with the reason `background`, not `still-working`. Only the label changes. The status, the exit codes and the proof rules stay the same. The agent counts only from a reply whose last line is the exact token line. See [The proof](#the-proof).

The label says "background work" because `state: "working"` with `mainAgent.state: "done"` may also match work that is not a shell.

`background` needs `mainAgent.state`. A row without `mainAgent` keeps `still-working`, even with `workingMode: "monitoring"`. Orca does not document `mainAgent`. It was seen on Claude Code v2.1.296 only.

## Known limits

- The tool works only with Claude Code agents on the local Orca host. It does not support remote hosts or other agent types.
- Races remain between the last check and a send. An agent can open a dialog in between.
- Whether an agent in the background state handles a message that is sent to it is not tested. The tool does not claim that it will ack or pause.
- A queued broadcast can still be carried out just before a `pause` or a `close` abandons it. An agent that has the message in its queue may handle it while the tool marks it `abandoned`. A late ack on an abandoned target is ignored.
- Machine sleep is out of scope. The scenario is "machine stays on, you are away": network loss, a break, end of day or a usage limit. `recover` handles a reboot or an Orca crash, for Claude Code agents only.
