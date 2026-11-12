# Status

`orca-broadcast status` prints the one open run, once. Use it to see which targets still need help while another command waits. It works from any terminal, also from a `!` command in Claude Code, which has no terminal for [the live block](how-it-works.md#the-live-block).

The terms are defined in [CONTEXT.md](../../CONTEXT.md).

## What status does

`status` only reads the state folder. It never sends a message, never takes the lock and never calls Orca. It is safe to run while another command waits. It is also safe to run inside a Claude session.

It takes no argument and no filter. Any other flag, or any argument, is refused with exit `2`.

```sh
orca-broadcast status
orca-broadcast status --json
```

## Which run

`status` shows the one open run:

1. An open pause run wins.
2. Otherwise, the newer of an open recovery and an open broadcast. On a tie, the recovery wins.

The rule is the same one that the record store uses to choose the open record. See [One record at a time](how-it-works.md#one-record-at-a-time).

With no open run, `status` prints `no open run` and exits `0`.

## The text output

The output has a header, one row per target and a count line.

```
broadcast 20261112T100000000Z-a1b2c3d4 · running · saved 4s ago
  alpha/docs      coordinator  pending
  alpha/main      worker       pending  waiting-permission
  beta/feature-x  session      acked
1/3 acked, 2 pending
```

### The header

The header has up to three parts, separated by ` · `:

1. The kind of the run and its ID. The kind is `broadcast`, `recovery` or `pause run`.
2. `running`, or `not running: <next step>`.
3. `saved <age> ago`. This part is left out when the record has no valid save stamp: no stamp, or one that is not a date. See [The save stamp](#the-save-stamp).

`running` means that the lock file names a live process with the same start time as the one in the lock. When the lock holds no start time, only the process ID counts. It is the stale-lock rule of [The lock](how-it-works.md#stale-lock). A pause run has no process ID of its own, so only the owner of the lock shows a live process.

When no process runs the open run, the header says what to do next:

| Run | Next step |
|---|---|
| Broadcast | `re-run broadcast to continue` |
| Recovery | `re-run recover to continue` |
| Pause run, pause phase | `run pause again or resume to continue` |
| Pause run, resume phase | `re-run resume to continue` |

### The rows

`status` shows every row of the record. This includes the agent of the running session and the gone agents. Each row has `<repo>/<worktree>`, the role, the status and the reason. A row with no reason has an empty last column.

The rows that are pending come first. Then come the rows that are done. Each group is sorted by repo, then worktree, then role.

A row is pending in these cases:

| Run | Pending row |
|---|---|
| Broadcast | The target has the status `pending`. |
| Pause run, pause phase | The agent has the pause status `unconfirmed`. |
| Pause run, resume phase | The agent has the resume status `pending`. |
| Recovery | The row is not final. See [When the recovery record closes](recover.md#when-the-recovery-record-closes). |

Every other row is done.

The rule of the pause phase is not the rule of [the live block](pause-and-resume.md#the-live-block-of-pause). `status` leaves out an agent whose pause send failed (reason `send-failed`), a gone agent and the agent of the running session. The block keeps an agent with `send-failed`, and it shows only the selected agents.

### The count line

The count line is `<done>/<total> <word>, <pending> pending`. The `total` is every row of the section. The `done` is the `total` minus the pending rows. The word depends on the run:

| Run | Word |
|---|---|
| Broadcast | `acked` |
| Recovery | `final` |
| Pause run, pause phase | `confirmed` |
| Pause run, resume phase | `resumed` |

## A pause run

A pause run is in the resume phase once any agent has a CONTINUE send time in the record. Before that, it is in the pause phase. The status column shows the pause status and reason in the pause phase. It shows the resume status and reason in the resume phase.

The agents are always the main rows of a pause run. When the run also holds the rows of its latest `recover` (pause-run mode), `status` prints them after the agents, in a second section. The section starts with the heading `latest recover` and ends with its own count line, with the word `final`.

## The save stamp

Every save of a record adds a [`savedAt` time](how-it-works.md#the-save-stamp) to its file. The header shows its age: `<n>s` under one minute (for example `saved 12s ago`), else `m:ss` (for example `saved 1:05 ago`).

The age tells fresh data from stale data. `resume` saves nothing at its confirm prompt, and nothing while no agent is sendable. During its proof wait, it saves at each poll, so the age stays small. For up to one poll after `resume` sends CONTINUE, the record can still show the pause phase.

An older record has no stamp. Then the header shows no age and `savedAt` is `null` in `--json`.

## JSON output

`--json` prints one JSON object on stdout:

```json
{"command":"status","open":null}
```

When a run is open, `open` holds these fields:

| Field | Meaning |
|---|---|
| `kind` | `broadcast`, `recovery` or `pause`. |
| `id` | The ID of the run. |
| `command` | `broadcast` for a broadcast and `recover` for a recovery. For a pause run, `pause` in the pause phase and `resume` in the resume phase. |
| `running` | `true` when a process runs the run. |
| `savedAt` | The ISO time of the last save, or `null`. |
| `phase` | `pause` or `resume` for a pause run, else `null`. |
| `counts` | `done`, `pending` and `total`. |
| `rows` | One object per row, in the order of the text: `repo`, `worktree`, `role`, `status` and `reason`. The `reason` is `null` when there is none. |
| `latestRecover` | `null`, or `{ "counts", "rows" }` for the `latest recover` section of a pause run. |

The object has no `warnings`, `outcome` or `exitCode` field. A refused command line or an unreadable state folder prints the usual error object instead. See [JSON output](reference.md#json-output).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | `status` could read the state. This includes no open run, and an open run that no process runs. |
| `2` | The state folder cannot be read, or the command line is refused (an unknown flag or an argument). |

For the exit codes of every command, see [Exit codes](reference.md#exit-codes).
