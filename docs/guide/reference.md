# Reference

This page lists every option, the exit codes of every command, the Tab completion rules and the `--json` rules. The terms are defined in [CONTEXT.md](../../CONTEXT.md).

## Options

Each row names the commands that accept the option. A command that gets an option it does not accept exits `2`, unless `--help` is also given.

| Option | Effect | Commands |
|---|---|---|
| `--timeout <n>s\|m\|h` | How long the command waits. Use a positive whole number and `s`, `m` or `h`, such as `90s`. Default `10m`. `pause` waits for confirmations. `broadcast` waits for acks, and each re-run waits a fresh time. `recover` limits the whole command from its start. The time that its question waits does not count. | `pause`, `broadcast`, `recover` |
| `--file <path>` | Read the `broadcast` text from a file. The text may have several lines. Give the text or `--file`, not both. | `broadcast` |
| `--reason <name>` | Say why you pause. Use `network`, `away`, `end-of-day`, `limit` or `restart`. Without it, the message is neutral. | `pause` |
| `--yes` | Skip the confirmation before the command sends anything. Without a terminal, the command refuses to send unless you pass `--yes`. `close` never asks, so it never needs `--yes`. | `pause`, `resume`, `broadcast`, `recover` |
| `--json` | Print one JSON object on stdout. See [JSON output](#json-output). | `pause`, `resume`, `broadcast`, `close`, `recover`, `status`, `group`, `roster save` |
| `--group <name>` | Use a saved group. Repeat the option to use the union of several groups. `group add` does not accept it. | `broadcast`, `pause`, `resume`, `close`, `recover` |
| `--state <working\|done>` | Select agents by their live state. Repeat the option for both states. | `broadcast`, `group add` |
| `--repo <id\|path\|name>` | Select the agents of a repo. Repeat the option for several repos. | `broadcast`, `pause`, `resume`, `close`, `recover`, `group add` |
| `--worktree <path\|id\|name>` | Select the agents of a worktree. Repeat the option for several worktrees. | `broadcast`, `pause`, `resume`, `close`, `recover`, `group add` |
| `--role <coordinator\|worker\|session>` | Select the agents with a role. Repeat the option for several roles. | `broadcast`, `pause`, `resume`, `close`, `recover`, `group add` |
| `--run <id>` | Select the agents of an orchestration run. Use an exact run ID. Repeat the option for several runs. | `broadcast`, `pause`, `resume`, `close`, `recover`, `group add` |
| `--keep-tabs` | Do not clear a worktree before the first start there. The confirmation lists no worktree to clear. See [Restored tabs and titles](recover.md#restored-tabs-and-titles). | `recover` |
| `--help` | Show the help text and exit `0`. | `broadcast`, `pause`, `resume`, `close`, `recover`, `status`, `group`, `roster`, `completion` |

## Exit codes

`broadcast`, `pause`, `resume`, `close` and `recover` take the lock. `group`, `roster save`, `status` and `completion` take no lock.

| Code | Command | Meaning |
|---|---|---|
| `0` | `pause` | No agent in scope is unconfirmed. Also "nothing to do". |
| `0` | `resume` | Every selected agent is resumed or gone. A filter can leave the run open and still give `0`. Also "nothing to resume". |
| `0` | `broadcast` | Every target in scope acked. Also "nothing to broadcast". |
| `0` | `close` | The command finished. Also "nothing to close". |
| `0` | `recover` | No row is `pending`, `gone`, `no-coordinator` or `failed`. Rows `restored`, `restarted`, `acked`, `left-to-coordinator` and `abandoned` give `0`. Also "nothing to recover". |
| `0` | `status` | `status` could read the state. This includes no open run, and an open run that no process runs. |
| `0` | `roster save` | The roster is saved. |
| `0` | `group` | The call succeeded. |
| `0` | `completion` | `completion bash` printed the script. |
| `1` | `pause` | At least one agent is unconfirmed. |
| `1` | `resume` | At least one selected agent is still pending. |
| `1` | `broadcast` | At least one target in scope did not ack. A `gone` target counts as not acked. |
| `1` | `recover` | At least one row is `pending`, `gone`, `no-coordinator` or `failed`, or you answered no. |
| `1` | `roster save` | The roster is not saved. A failed scan or Orca listing gives `1`. |
| `2` | `pause`, `resume`, `broadcast`, `close`, `recover` | A usage error. A filter or group value that is unknown or ambiguous. With `--group`, the groups file is invalid or cannot be read. Another `orca-broadcast` is running. A record that cannot be read. |
| `2` | no command | A usage error: the command is missing or unknown, or an option is unknown and no command is named. |
| `2` | `pause`, `resume`, `broadcast` | You answered no. The message is `cancelled: nothing was sent`. |
| `2` | `pause`, `resume`, `broadcast`, `recover` | No terminal, or `--json`, and no `--yes`. |
| `2` | `pause`, `resume`, `broadcast`, `recover` | The Orca listing failed. |
| `2` | `pause`, `resume`, `broadcast`, `close`, `recover` | The run or the record cannot be saved. |
| `2` | `pause`, `resume`, `close`, `recover` | Every named group has only a `state` kind. |
| `2` | `pause`, `resume`, `recover` | The open run is of an older format. |
| `2` | `pause` | The `--reason` differs from the reason of the open run. Run `close` first. |
| `2` | `pause` | The hand-over is refused: the lock holder is not the open broadcast, the lock owner changed, the signal is not allowed (EPERM), or the lock is still held after 5 seconds. |
| `2` | `broadcast` | A pause run or a recovery is open. There is no text and no open broadcast. The text differs from the open broadcast. The text is empty, too long, or has a refused character. The `--file` cannot be read. |
| `2` | `close` with filters | A recovery and a broadcast are open together. Also an open run of an older format. |
| `2` | `recover` | There is no roster, no open pause run and no open recovery. A roster file cannot be read. The scan of the Claude processes fails. A broadcast is open and no pause run is open. The fleet restarted again while a recovery is open. |
| `2` | `group` | A usage error: the subcommand is missing or unknown, an option does not apply, or the argument count is wrong. The groups file is invalid or cannot be saved. A value does not resolve. The Orca listing fails. The group name is invalid, has no filter, exists already, or is unknown. |
| `2` | `roster save` | A usage error: the subcommand is missing or unknown, an option does not apply, or there is an extra argument. |
| `2` | `status` | The state folder cannot be read, or the command line is refused: an option other than `--json` or `--help`, or any argument. |
| `2` | `completion` | Any option other than `--help`, no argument, or an argument other than `bash`. |
| `130` | `pause`, `resume`, `broadcast`, `close`, `recover` | The command was interrupted by SIGINT, SIGTERM or SIGHUP, or by Ctrl-C at its question (`close` asks no question). Run the command again to continue. |

What an interrupted command leaves on disk depends on the command and the phase:

- An interrupt before the command takes the lock writes no run and no record.
- `pause`, `resume`, `broadcast` and `recover` save their open run or record when the interrupt comes during their send or wait phase.

## Tab completion

To complete commands, options and option values in bash, add this line to `~/.bashrc`:

```sh
eval "$(orca-broadcast completion bash)"
```

Tab then offers:

- the commands `broadcast`, `pause`, `resume`, `close`, `recover`, `status`, `group`, `roster` and `completion`, and the subcommands of `group`, `roster` and `completion`;
- only the options that the typed command accepts;
- the values of `--role`, `--state` and `--reason`, also in the form `--flag=value`;
- your saved group names after `--group`, `group show` and `group remove`.

Anything else falls back to file names. Tab completion reads only the groups file. It never calls Orca.

## JSON output

`--json` prints one JSON object on stdout and a newline. It prints nothing on stderr. The one exception is the line about each skipped group `state` kind. It never prompts, so `broadcast`, `pause`, `resume` and `recover` need `--yes`.

Every object has a `warnings` array, except the object that `status` prints when it could read the state. A refused or failed `status` call prints the error object, which has the array. The array holds the warning lines that text mode prints on stderr, such as a roster save that failed. The line about a skipped group `state` kind is not in `warnings`.

| Command | Fields |
|---|---|
| `broadcast`, `pause`, `resume`, `close` | `command`, `outcome`, `exitCode`, `run`, `record`, `error`, `warnings` |
| `recover` | `command`, `outcome`, `exitCode`, `run`, `record`, `error`, `rows`, `snapshots`, `cleared`, `warnings` |
| `group add`, `group list`, `group show`, `group remove` | `command`, `outcome`, `exitCode`, `error`, `groups`, `warnings` |
| `status` | `command`, `open` |
| `roster save` | `command`, `outcome`, `agents`, `warnings` |

The fields mean:

| Field | Meaning |
|---|---|
| `command` | The command name. It is `null` when the call fails before the command name is set. For `group` and `roster` calls with a missing or unknown subcommand, it is `group` or `roster`. |
| `outcome` | `done`, `nothing-to-do` or `error`. For `group`, `done` or `nothing-to-do`, and `error` for an error. For `roster save`, `saved` or `skipped`, and `error` for an error. |
| `exitCode` | The exit code of the process. A `roster save` result has no `exitCode`, unless it is an error. |
| `run` | The pause run, or `null`. For `recover`, the pause run only when the outcome is `done` in pause-run mode. |
| `record` | The broadcast record or the recovery record, or `null`. |
| `error` | The error message, or `null`. |
| `rows` | `recover` only. One object per agent. |
| `snapshots` | `recover` only. The roster snapshot lines that `recover` used. |
| `cleared` | `recover` only. The worktrees that this run cleared, as `{ "repo", "worktree" }`. `[]` when none. In crash mode the `record` also holds `cleared`, with every clear of the recovery. |
| `groups` | `group` only. The groups that the call touched, or `null` for an error. |
| `open` | `status` only. `null` when no run is open, else the open run, as the [status page](status.md#json-output) shows it. |
| `agents` | `roster save` only. The number of saved agents, or `null`. |
| `warnings` | The warning lines. For `group`, always `[]`. For `roster save`, `[]` when saved, and the reason when skipped. |

These rules also hold:

- `status` prints its own object when it can read the state. A refused command line or an unreadable state folder prints the usual error object of the other commands. See [JSON output of status](status.md#json-output).
- For `broadcast`, `pause`, `resume`, `close` and `recover`, a command that exits `1` has outcome `done`, and a command that exits `2` or `130` has outcome `error`. A skipped `roster save` has outcome `skipped` and exits `1`.
- A `roster save` error object also has `exitCode` (`2`) and `error`.
- When `close` closes a recovery and a broadcast that are open together, `warnings` holds `closed broadcast <id>`.
- A `broadcast` object has `run` set to `null`. Its `record` holds the broadcast record, or `null` when the broadcast is refused or nothing is in scope. When nothing is in scope, the outcome is `nothing-to-do`.
- Each agent of a pause `run` has `orchestrationRunIds`.
- A `--json` call that fails before the command name is set prints the shape of `broadcast`, `pause`, `resume` and `close` with `command` `null`. This holds for `broadcast a b --json`, `recover --json --bogus` and `completion bash --json`. A call that `orca-broadcast` labels `group` or `roster` prints the shape of that command.
