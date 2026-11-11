# Broadcast

`broadcast` sends one message to every working or done Claude agent. It then proves that each agent handled the message.

For the terms on this page, see [CONTEXT.md](../../CONTEXT.md).

## What `broadcast` does

`broadcast` sends one framed message to every Claude agent in state `working` or `done`. A working agent gets the message queued after its current step.

`broadcast` never targets these agents:

- An agent on a permission prompt. Orca shows it as `waiting`. `broadcast` also skips an agent in any state other than `working` or `done`.
- The session that runs `broadcast`. The prompt shows that session on its own line. It cannot ack while its own command waits.

Other commands can block `broadcast`. See [One record at a time](how-it-works.md#one-record-at-a-time).

## Examples

Give the same instruction to every working or done agent, and prove that each one handled it:

```sh
orca-broadcast broadcast "back up the /tmp files you need"
orca-broadcast broadcast --file message.txt --timeout 5m
orca-broadcast broadcast "stop and push" --repo alpha --role worker   # only some agents
orca-broadcast broadcast                  # after a timeout: keep waiting on the open broadcast
```

## The text

Give the text inline or with `--file <path>`. Do not give both.

The text must follow these rules:

| Rule | Detail |
|---|---|
| Trim | The command trims both ends of the text. |
| Not empty | An empty text is refused. |
| Lines | The text may have several lines. The command turns `\r\n` into `\n`. |
| Control characters | A newline is the only control character allowed. The command refuses a tab, a lone `\r` and an escape character. |
| Length | The text has at most 4000 characters. The command counts them after the `\r\n` conversion. |

If a rule fails, the command exits `2` and names the reason. For a text that is too long, it also gives the length. It sends nothing.

## The prompt

Before the command sends anything, it asks you to confirm. It shows:

1. The targets, one line each: `<repo>/<worktree> (<role>)`.
2. The message, after `Message:`. The prompt shows each Unicode format character, such as U+202E, as `\u{HEX}`.
3. The session that runs the command, after `Not sent to this session:`. This line appears only when that session is a live Claude agent, or a target of the open broadcast.
4. The question `Send to N agents? [y/N]`. For one target, the question says `1 agent`.

Pass `--yes` to skip the whole prompt. Without a terminal, `--yes` is required. This holds even when the command sends nothing. See [Options](reference.md#options).

## The message

For a text of one line, the message is:

```
[orca-broadcast] The user sends you this message: "<text>" Handle it now. If you are in the middle of a step, finish that step first. When you have handled it, end your reply with a short note on what you did. The last line of your reply must be exactly: ORCA-ACK <token>
```

For a text with a newline, the message is:

```
[orca-broadcast] The user sends you this message. It starts on the next line and ends at the line "[end of message]".
<text, on its own lines>
[end of message]
Handle it now. If you are in the middle of a step, finish that step first. When you have handled it, end your reply with a short note on what you did. The last line of your reply must be exactly: ORCA-ACK <token>
```

In both forms, the text comes before the instruction to end with the ack line.

## The proof

An agent counts as acked when all of these are true:

1. The command sent the message, and Orca accepted it.
2. The agent has a reply that is new since the send.
3. The last line of that reply is exactly `ORCA-ACK <token>`. The command ignores blank lines at the end and spaces around the line. It also accepts the line inside one pair of backticks.
4. The agent is in state `working` or `done`.

The agent also counts as acked when its transcript shows a reply that ended a turn since the send, with the same last line. Any such reply proves the target, also when later turns follow. Text that the agent writes between tool calls never counts. An agent with no readable transcript is proven as in the list above. See [The proof](how-it-works.md#the-proof).

An ack is permanent. A receipt of a send is never proof.

## The broadcast record

The command writes the broadcast record in `broadcasts/` before the first send. The targets are fixed at your confirmation. For the state folder, see [Records and the state folder](how-it-works.md#records-and-the-state-folder).

The record closes itself when every target is acked, gone or abandoned. After a timeout, the record stays open.

While `broadcast` runs, the record holds its pid. The command removes the pid on every exit.

## The wait

The command waits up to `--timeout`. The default is `10m`. A re-run waits a fresh time.

The wait ends in these cases:

- No target in scope is pending.
- Every pending target in scope is `send-failed`. Nothing can progress then, so the command stops early.
- The timeout ends.

A `gone` target counts as not acked.

The exit codes are `0` when every target in scope acked, `1` when not, `2` on a refusal and `130` when you interrupt the command. For the exit codes of every command, see [Exit codes](reference.md#exit-codes).

## Reasons

A pending target shows one reason:

| Reason | Meaning |
|---|---|
| `send-failed` | Orca did not accept the send. |
| `waiting-permission` | The agent is on a permission prompt, or in a state other than `working` or `done`. |
| `no-ack` | The agent replied since the send, but the last line is not the ack line. The command does not send the message again. A later ack still counts. |
| `background` | The agent's turn ended and background work runs. See [Background work](how-it-works.md#background-work). |
| `still-working` | The agent has not replied yet. It is not on a permission prompt, and no background work runs. |

## Re-run

`broadcast` with no text, or with the same text, continues the open broadcast. It keeps the same token and waits a fresh `--timeout`.

A re-run follows these rules:

- It never adds targets.
- It never includes the session that runs it.
- It sends again only to targets that never got the message, or whose send failed.
- It asks first whenever a send is due, even if that target is `waiting` now.
- When no send is due, it only waits. It shows no prompt. Without a terminal, it still needs `--yes`.
- It ignores a late ack on an abandoned target.

A different text is refused with exit `2`. Run `close` first. See [Close](#close).

## Filters

`--repo`, `--worktree`, `--role`, `--run`, `--state working|done` and `--group` select the agents of a first broadcast. Repeat a flag to give several values. For how the kinds combine, and for the groups, see [How filters combine](filters-and-groups.md#how-filters-combine) and [Groups](filters-and-groups.md#groups). For the flags of every command, see the [flag table](filters-and-groups.md#flag-table-per-command).

A group's `state` kind applies to `broadcast`. See [The state kind](filters-and-groups.md#the-state-kind).

A re-run uses the filters to narrow the recorded targets:

- `--role`, `--run`, `--repo` and `--worktree` match the values saved in the record.
- `--state` matches the live state. A `gone` target never matches.

The scope is the matching targets that are `pending`, `acked` or `gone`. These rules follow:

- A target outside the scope keeps its status. The command does not wait on it.
- The exit code covers only the scope.
- The record stays open while a target outside the scope is pending.
- An `abandoned` target is shown but is never in scope.

Some runs have nothing to send. The command then prints `nothing to broadcast` and the filters, and exits `0`. This happens in three cases:

- A first broadcast selects no agent.
- Every target you confirmed is gone before the send.
- A re-run has no target in scope.

## JSON output

`--json` prints one JSON object. It needs `--yes`. See [JSON output](reference.md#json-output) for the rules of every command.

For `broadcast`, the fields differ from the usual object in these ways:

| Field | Value |
|---|---|
| `run` | Always `null`. |
| `record` | The broadcast record. It is `null` when no record exists, for example when the command refuses to run or when nothing is in scope. |
| `outcome` | `nothing-to-do` when nothing is in scope. |

## Close

`close` abandons targets of an open broadcast. An abandoned target gets the reason `closed`.

| Command | What it abandons |
|---|---|
| `close` | Every pending target. |
| `close` with filters or `--group` | Only the matching pending targets. |

With filters, the command matches the targets against the live listings, when Orca answers, and against the identity saved in the record.

Acked and gone targets stay as they are.

The record closes itself when nothing is pending. The command then prints `closed broadcast <id>`. Otherwise, the record stays open. The command prints `broadcast <id> stays open: N targets abandoned`. For one target, it prints `1 target`.

If no target matches, `close` prints `nothing to close` and exits `0`.

## Limit

A queued message can still run just before a `close` or a `pause` abandons its target. See [Known limits](how-it-works.md#known-limits).
