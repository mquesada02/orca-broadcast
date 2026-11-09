# Filters and groups

A filter narrows the agents that a command acts on. With no filter and no group, the command is not narrowed.

A group is a saved set of filters (see [Groups](#groups) and the term [Group](../../CONTEXT.md)). Repeat a filter flag to give several values. Repeat `--group` to use the union of several groups.

`orca-broadcast <command> --help` lists the flags of one command.

## Filters

Each filter flag selects agents:

| Flag | Selects |
|---|---|
| `--repo <id\|path\|name>` | The agents in that repo. A path must be absolute: a relative path never matches. |
| `--worktree <path\|id\|name>` | The agents in that worktree. A path may be relative to the current folder. A name is looked up among all known worktrees. When you give `--repo`, the lookup uses only the worktrees of those repos. |
| `--role <coordinator\|worker\|session>` | The agents with that role. |
| `--state <working\|done>` | The agents in that live state. `broadcast` only. |
| `--run <id>` | The agents that have that orchestration run among their runs. Give an exact run ID. |
| `--group <name>` | The agents of that saved group. |

A `--repo`, `--worktree` or `--run` value that matches nothing known is refused with exit 2. So is a value that matches several things.

`--reason <name>` is not a filter. It sets the reason of a `pause`.

### Flag table per command

| Flag | `broadcast` | `pause` | `resume` | `close` | `recover` |
|---|---|---|---|---|---|
| `--repo` | yes | yes | narrows the run | narrows the run | selects the agents to recover |
| `--worktree` | yes | yes | narrows the run | narrows the run | selects the agents to recover |
| `--role` | yes | yes | narrows the run | narrows the run | selects the agents to recover |
| `--state` | yes | refused (exit 2); skipped in groups | refused (exit 2); skipped in groups | refused (exit 2); skipped in groups | refused (exit 2); skipped in groups |
| `--run` | yes | yes | narrows the run | narrows the run | selects the agents to recover |
| `--group` | yes | yes | narrows the run | narrows the run | selects the agents to recover |
| `--reason` | refused (exit 2) | yes | refused (exit 2) | refused (exit 2) | refused (exit 2) |

The cells mean this:

| Cell | Meaning |
|---|---|
| yes | The command accepts the flag. A filter flag selects agents. `--reason` sets the reason. |
| narrows the run | The flag only selects among the recorded agents. On `resume` these are the agents of the open pause run. On `close` they are the agents of the open pause run, the open broadcast or the open recovery. The flag never adds an agent. |
| selects the agents to recover | The flag picks the part of the pre-restart roster that `recover` works on. With an open pause run, it selects among the agents of that run and the roster agents outside it. With an open recovery record, it narrows that record. The other rows keep their result. |
| refused (exit 2) | The command stops with a usage error and exit code 2. |
| skipped in groups | The flag itself is refused. A saved group that has a `state` kind still works if it has another kind. The command skips the `state` kind and prints one line on stderr for each such group. When every named group has only a `state` kind, the command is refused with exit 2. See [The state kind](#the-state-kind). |

A `broadcast` re-run also narrows its recorded targets with these flags. It never includes abandoned targets or the calling session.

`pause` with an open run also adds the filter set to that run. A matching agent that is already in the run is paused again in these cases:

- You resumed it.
- A filtered `close` abandoned it.
- Its earlier pause failed to send.
- A wake-up undid its earlier pause.

Matching agents that still wait for their pause are included in this call. The set stays on the run, so the pause also takes in new working agents that match it.

`close` has one exception. When a recovery record and a broadcast are both open, `close` with any filter or `--group` is refused with exit 2. The message is ``a recovery and a broadcast are both open; run `orca-broadcast close` without filters``.

## How filters combine

Different kinds of filter are ANDed. Several values of one kind are ORed.

So `--repo alpha --repo beta --role worker` means the workers in `alpha` or `beta`.

Several `--group` flags select the union of their groups. An agent is selected when it matches any one group. Each group keeps its own meaning: kinds ANDed, values of one kind ORed.

A kind that is in both a group and the flags gives the intersection of the two. An empty intersection prints `nothing to <command>`. One exception: `pause` on an open run still adds the empty set to the run.

## Examples

```sh
orca-broadcast pause --repo alpha                       # pause one repo
orca-broadcast pause                                    # widen the open run to all agents
orca-broadcast resume --role worker                     # resume only the workers
orca-broadcast group add web --repo alpha --repo beta   # save a group ...
orca-broadcast pause --group web                        # ... and use it
orca-broadcast broadcast "push your branch" --group web --role worker   # a group, narrowed by a filter
orca-broadcast pause --group web --group docs           # the agents of either group
```

## Groups

The five commands `broadcast`, `pause`, `resume`, `close` and `recover` take `--group <name>`. The filters `--repo`, `--worktree`, `--role`, `--run` and, on `broadcast`, `--state` narrow every group.

```sh
orca-broadcast group add web --repo alpha --role worker   # every value must resolve to one thing now
orca-broadcast group list
orca-broadcast group show web      # the filters, and the agents that match now; sends nothing
orca-broadcast group remove web
orca-broadcast pause --group web --role worker
```

No `group` subcommand sends a message. `group show` reads the live agents. It lists the working or done Claude agents that match the group now. It prints `no agents match` when none does.

### The groups file

- The file is `$XDG_CONFIG_HOME/orca-broadcast/groups.json`. The default is `~/.config/orca-broadcast/groups.json`.
- The shape is `{"version": 1, "groups": {"<name>": {"repo": [], "worktree": [], "role": [], "state": [], "run": []}}}`.
- A kind that you leave out is unfiltered. A group needs at least one kind.
- You may edit the file by hand.
- An invalid file exits 2 and names the path.
- A missing file means no groups.
- Writes are atomic: the command writes a temporary file, then renames it. A write takes no lock.

### Group names

A name has lowercase letters, digits and `-`. It starts with a letter. It has at most 40 characters. `group add` refuses a name that exists. Run `group remove` first.

### How a group is used

- `group add` checks the `--repo`, `--worktree` and `--run` values at once. Each value must resolve to exactly one thing now. This is the refusal rule of [Filters](#filters).
- `group add` saves a `--worktree` value that holds a `/` or starts with `.` as an absolute path. It saves any other value as you typed it.
- A command resolves the values again at each use. A value that no longer resolves exits 2 and names the group and the value.
- Naming a group twice is the same as naming it once. An unknown name exits 2 before anything is sent.
- `pause` copies the resolved groups into the run. Editing the file does not change an open run until your next `pause`.

### The state kind

`group add --state working|done` saves a `state` kind. Only `broadcast` uses it.

`pause`, `resume`, `close` and `recover` skip the `state` kind of each group. They print one line on stderr for each group that has a `state` kind: `orca-broadcast: group <name>: state filter skipped (<command> does not use it)`.

A group that has no other kind is dropped from a union. It never selects every agent. When every named group has only a `state` kind, the command is refused with exit 2.
