# orca-broadcast

Pause every working Claude Code agent in the Orca IDE before you leave (your network drops, you step away, the day ends, a usage limit is close), and resume all of them when you are back — with proof that none was missed.

`orca-broadcast pause` asks each agent to finish the step it is on, write a short "where I stopped" note, and wait. It then checks that every agent actually stopped. `orca-broadcast resume` tells every recorded agent to continue and checks that each one did.

## Requirements

- Linux, with Orca running and its CLI available as `orca-ide`
- Node.js 22 or later, and pnpm
- Agents must be Claude Code sessions on the local Orca host

## Install

```sh
git clone git@github.com:mquesada02/orca-broadcast.git
cd orca-broadcast
pnpm install
pnpm build
```

Then put the CLI on your `PATH`, either with `pnpm link --global` (needs pnpm's global bin directory on `PATH`, see `pnpm setup`) or with a small wrapper:

```sh
printf '#!/bin/sh\nexec node %s/dist/bin.js "$@"\n' "$PWD" > ~/.local/bin/orca-broadcast
chmod +x ~/.local/bin/orca-broadcast
```

## Usage

Run the commands from a plain terminal, not from inside a Claude session. An agent cannot pause itself while it runs a command.

Before you leave:

```sh
orca-broadcast pause            # lists the agents, asks "Send to N agents? [y/N]", then waits
orca-broadcast pause --timeout 3m
orca-broadcast pause --reason end-of-day   # tell the agents why you are pausing
```

When you are back:

```sh
orca-broadcast resume
```

If a run can never finish (for example an agent ignores the message), abandon it:

```sh
orca-broadcast close
```

To give the same instruction to every working or done agent, and prove each one handled it:

```sh
orca-broadcast broadcast "back up the /tmp files you need"
orca-broadcast broadcast --file message.txt --timeout 5m
orca-broadcast broadcast "stop and push" --repo alpha --role worker   # only some agents
orca-broadcast broadcast                  # after a timeout: keep waiting on the open broadcast
```

### Broadcast

`broadcast` sends one framed message to every Claude agent in state `working` or `done`. It never targets an agent on a permission prompt (`waiting`), and never the session that runs it (that session is shown on its own line, because it cannot ack while its own command waits). A working agent gets the message queued after its current step.

- **Text.** Inline or `--file <path>`, not both. Both ends are trimmed. The text may have several lines: `\r\n` is turned into `\n`, and a newline is the only control character allowed (a tab, a lone `\r` or an escape character is refused). The text must not be empty and must have at most 4000 characters, counted after that conversion. Otherwise the command exits 2 with the reason and the length, and nothing is sent.
- **Prompt.** The target table, the exact message and the self line are shown before anything is sent. Without a terminal `--yes` is required, whatever the command does next.
- **Message.** For a one-line text: `[orca-broadcast] The user sends you this message: "<text>" Handle it now. …`. For a text with a newline: `[orca-broadcast] The user sends you this message. It starts on the next line and ends at the line "[end of message]".`, then the text on its own lines, a `[end of message]` line and `Handle it now. …`. Both forms end with the instruction that the last line of the reply must be exactly `ORCA-ACK <token>`; the text always comes before that instruction.
- **Proof.** An agent counts as acked when no message is pending for it, its last reply is new since the send, and the last line is exactly `ORCA-ACK <token>`, in a `working` or `done` state. An ack is permanent. Send receipts are never proof.
- **Record.** The record is written in `broadcasts/` before the first send, with the targets fixed at the confirmation. It closes itself when every target is acked, gone or abandoned. After a timeout it stays open; `close` abandons the targets that did not ack (reason `closed`). The pid of the running `broadcast` is stored in the record and removed on every exit.
- **Wait.** Up to `--timeout` (default `10m`). It ends early when every target still pending is `send-failed`, because nothing can progress. Exit `0` when every target acked, `1` otherwise (a `gone` target counts as not acked), `2` on a refusal, `130` when interrupted.
- **Reasons.** A pending target shows one reason: `send-failed` (the send was rejected), `waiting-permission`, `no-ack` (it replied since the send, but the last line is not the ack line; it is not sent the message again, and a later ack still counts), `background` (the turn ended and background work runs; see "Background work") or `still-working`.
- **Re-run.** `broadcast` with no text, or with the same text, continues the open broadcast: same token, a fresh `--timeout`. It never adds targets and never includes the session that runs it. It sends again only to targets that never got the message or whose send failed, and asks first whenever there is one (even if that target is `waiting` now). When nothing needs a send it only waits, with no prompt; without a terminal it still needs `--yes`. A different text is refused (exit 2); `close` the broadcast first. A late ack on an abandoned target is ignored.
- **Filters.** `--repo`, `--worktree`, `--role`, `--run`, `--state working|done` and `--group` (repeatable) select the agents of a first broadcast. Kinds are ANDed, values of one kind are ORed. A group's `state` kind applies to `broadcast`. Several `--group` flags are a union of the groups (see "Groups"), and the other filters narrow it. On a re-run they narrow the recorded targets: role, runs, repo and worktree match the values saved in the record, `--state` matches the live state (a `gone` target never matches). The scope is the matching targets that are `pending`, `acked` or `gone`. Targets outside it keep their status and are not waited on, so the exit code covers only the scope, and the record stays open while others are pending. `abandoned` targets are shown but never in scope. A filter that leaves nothing in scope prints "nothing to broadcast" and the filters, exit 0.
- **One record at a time.** `broadcast` is refused (exit 2) while a pause run is open. `resume` says "nothing to resume" while only a broadcast is open. `pause` is not refused because a broadcast is open: it stops a waiting broadcast (see "Pause stops a waiting broadcast").
- **JSON.** `--json` prints the usual object with `record` (the broadcast record) in place of `run`; `run` is `null`. When nothing is in scope, `outcome` is `nothing-to-do` and `record` is `null`.
- **Close.** `close` abandons every pending target. `close <filters>` (or one or more `--group`) abandons only the matching pending targets, resolved against Orca and the identity saved in the record; the record closes itself when nothing is pending and otherwise stays open ("broadcast <id> stays open: N targets abandoned"). Acked and gone targets are untouched. Nothing matching prints "nothing to close", exit 0.
- **Limit.** A queued message can still run just before a `close` or a `pause` abandons it (see "Known limits").

### Pause stops a waiting broadcast

A `broadcast` that waits for acks in another terminal holds the lock. `pause` does not wait for it:

1. `pause` checks its arguments before it takes the lock. With filters, it resolves the filter values with read-only calls to Orca. A typo in a filter value therefore fails with exit 2 before any broadcast is stopped.
   Next, `pause` looks at the lock. The hand-over starts only when the process that holds the lock is the one the open broadcast record names. The pid and the start time must both match, and that process must be alive with that start time. A lock without a start time never matches, so no hand-over happens.
   Then `pause` checks that fresh listings select at least one agent that matches the filters. After that, it sends the process SIGTERM and waits up to 5 seconds for the lock.
   The broadcast treats SIGTERM like Ctrl-C: it saves its record, clears its pid and exits 130.
2. Any other lock holder, a pid or start time that does not match, or a signal that is not allowed (EPERM) makes `pause` exit 2 at once, with no signal. A lock still held after 5 seconds also exits 2. A process that is already gone (ESRCH) is not an error.
3. With an open broadcast `pause` always shows its first prompt. Your "yes" (or `--yes`) is the commit point. At that point `pause` writes its run, then abandons the broadcast's unacked targets (reason `paused`), closes the broadcast and prints one warning line on stderr (not in `--json`). A decline, an interrupt or an error before it leaves the broadcast open, stopped, with no pid. `close` abandons it; `broadcast` with no text continues it.
4. If a pause run and a broadcast are both open (a crash between the writes), every command that loads records abandons the broadcast with reason `paused` and prints a line on stderr. If several records of one kind are open, the newest wins and the others are reported.

### Filters and groups

By default a command acts on every agent. Filters narrow that, and a group is a saved set of filters (see "Groups"). Repeat `--group` to act on the union of several groups. `orca-broadcast <command> --help` lists the flags of one command.

| Flag | `broadcast` | `pause` | `resume` | `close` |
|---|---|---|---|---|
| `--repo` | yes | yes | narrows the run | narrows the run |
| `--worktree` | yes | yes | narrows the run | narrows the run |
| `--role` | yes | yes | narrows the run | narrows the run |
| `--state` | yes | refused (exit 2); skipped in groups | refused (exit 2); skipped in groups | refused (exit 2); skipped in groups |
| `--run` | yes | yes | narrows the run | narrows the run |
| `--group` | yes | yes | narrows the run | narrows the run |
| `--reason` | refused (exit 2) | yes | refused (exit 2) | refused (exit 2) |

"Narrows the run" means the flag only selects among the agents the open run (or, for a `broadcast` re-run, the open broadcast) already recorded; it never adds an agent. Several `--group` flags select the union of their groups. On `resume` and `close` the union still only selects among the recorded agents. "Skipped in groups" means that `--state` itself is refused, but a group that has a `state` kind still works: the kind is skipped with one line on stderr per group.

Different kinds of filter are ANDed, and several values of one kind are ORed. So `--repo alpha --repo beta --role worker` means the workers in `alpha` or `beta`.

```sh
orca-broadcast pause --repo alpha                       # pause one repo
orca-broadcast pause                                    # widen the open run to all agents
orca-broadcast resume --role worker                     # resume only the workers
orca-broadcast group add web --repo alpha --repo beta   # save a group ...
orca-broadcast pause --group web                        # ... and use it
orca-broadcast broadcast "push your branch" --group web --role worker   # a group, narrowed by a filter
orca-broadcast pause --group web --group docs           # the agents of either group
```

### Groups

A group is a saved, named filter. `broadcast`, `pause`, `resume` and `close` take `--group <name>`, which you may repeat; other filters (`--repo`, `--worktree`, `--role`, `--run`, and `--state` on `broadcast`) narrow every group.

```sh
orca-broadcast group add web --repo alpha --role worker   # every value must resolve to one thing now
orca-broadcast group list
orca-broadcast group show web      # the filters, and the agents that match now; sends nothing
orca-broadcast group remove web
orca-broadcast pause --group web --role worker
```

- **File.** `$XDG_CONFIG_HOME/orca-broadcast/groups.json` (default `~/.config/orca-broadcast/groups.json`), `{"version": 1, "groups": {"<name>": {"repo": [], "worktree": [], "role": [], "state": [], "run": []}}}`. Omit a kind to leave it unfiltered; a group needs at least one kind. You may edit the file by hand. An invalid file exits 2 and names the path. A missing file means no groups. Writes are atomic and take no lock.
- **Names.** Lowercase letters, digits and `-`, starting with a letter, at most 40 characters. `group add` refuses a name that exists: `group remove` it first.
- **Use.** Values are resolved again at each use; a value that no longer resolves exits 2 and names the group and the value. Several `--group` flags are a union: an agent is selected when it matches any one group, and each group keeps its own meaning (kinds ANDed, values of one kind ORed). Naming a group twice is the same as once, and an unknown name exits 2 before anything is sent. A kind in both a group and the ad-hoc flags gives the intersection (an empty one prints "nothing to <command>", except that `pause` on an open run still adds the empty set). `pause` copies the resolved groups into the run, so editing the file does not change an open run until your next `pause`.
- **State.** `group add --state working|done` is for `broadcast`, where the `state` kind applies. `pause`, `resume` and `close` skip each group's `state` kind with one line on stderr. A group that then has no other kind is dropped from a union (it never selects every agent), and the command is refused (exit 2) when every named group has only a `state` kind.

### Options

| Option | Effect |
|---|---|
| `--timeout <n>s\|m\|h` | How long `pause` waits for confirmations, or `broadcast` waits for acks. Default `10m`. `pause` and `broadcast` only. |
| `--file <path>` | Read the `broadcast` text from a file; it may have several lines. `broadcast` only. |
| `--reason <name>` | Why you are pausing. One of the presets below. `pause` only. Without it the message is neutral. |
| `--yes` | Skip the confirmation prompt. Without an interactive terminal, `broadcast`, `pause` and `resume` refuse to send unless you pass it. |
| `--json` | Print one JSON object on stdout and nothing on stderr (except the line about each skipped group `state` kind). It never prompts, so `broadcast`, `pause` and `resume` need `--yes`. |
| `--group <name>` | Use a saved group. Repeat it for the union of the groups. `broadcast`, `pause`, `resume` and `close`. |
| `--state working\|done` | Select agents by their live state. Repeatable. `broadcast` only. |
| `--help` | Show help. |

### Pause reasons

`--reason` changes only the first sentence of the pause message and of the later continue message. Instructions, proof rules and safety rules are the same for every reason. The reason is saved in the run, so `resume` (which has no flag) sends the matching continue sentence.

| `--reason` | Pause sentence | Continue sentence |
|---|---|---|
| `network` | The user is leaving and the network will drop. | The network is back. |
| `away` | The user is stepping away for a while. | The user is back. |
| `end-of-day` | The user is stopping work for the day. | The user is back for a new session. |
| `limit` | The user is close to a usage or rate limit. | The limit has reset. |
| `restart` | The user will restart the PC soon, and everything in /tmp will be erased; first copy anything you still need from /tmp to a place outside it. | The PC has restarted; anything you left in /tmp is gone. |
| *(no flag)* | The user asked all agents to pause. | The user asked you to continue. |

After a real reboot, `resume` finds the restored agents only when #92 is done. Until then they show as `gone`, because agents are keyed on `paneKey`, which an Orca restart can change.

An unknown name, or `--reason` on `resume`, `close` or `broadcast`, is a usage error (exit 2). Running `pause` again on an open run keeps its reason; give the same `--reason` or none. A different one is refused (exit 2, nothing sent): use `close` first. The `reason` column in the output tables is a different thing: it says why one agent is not confirmed or not resumed.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | `pause`: every agent confirmed. `resume`: the run closed. `broadcast`: every target acked. Also "nothing to do". |
| `1` | `pause`: at least one agent is unconfirmed. `resume`: at least one agent is still pending. `broadcast`: a target did not ack, or is gone. The table says why and what to do. |
| `2` | Usage error, Orca listing failed, refused without `--yes`, or another `orca-broadcast` is running. |
| `130` | Interrupted (Ctrl-C, SIGTERM, SIGHUP). The record is saved; run the command again. |

## How it works

**Pause.** The tool lists agents with `orca-ide worktree ps` and selects every Claude agent in state `working`. Each agent has a role: `coordinator` (its terminal is a run's coordinator in `orca-ide orchestration run-list`, or another live agent's parent link points at it), `worker` (an active `orchestration worker-list` row, or its parent link points at a live agent), or `session`; coordinators win, and parent links come from `worktree ps`, so roles survive an Orca restart. Tables also show each agent's orchestration run ids (`run: unknown` when none is known), followed by one line "N agents have a role but no known run" when coordinators or workers have none; `--json` carries `orchestrationRunIds` per agent. Coordinators are messaged first and also told not to dispatch new work. Each agent gets one message with a random token and must end its reply with `ORCA-PAUSED <token>`. An agent counts as paused when no message is still pending for it, its last reply is new since the send, and that reply ends with that exact line. Its state does not matter, except that an agent on a permission prompt (or in an unknown state) never counts. A background task can keep Orca showing the agent `working`; that does not matter for the proof. The table shows such an agent as `background`, not `still-working` (see "Background work"). Send receipts are never taken as proof. The wait loop also sweeps up agents that start working later and re-pauses an agent that wakes up once.

**Resume.** The tool finds each recorded agent again by its Orca pane key, skips agents on a permission prompt, and sends `[orca-broadcast] CONTINUE …`. An agent counts as resumed when its state or last reply changes after the message (or, if it was still working, once Orca accepts the queued message). Workers and sessions are continued before coordinators. If `resume` runs in the session of a pending agent (its `ORCA_PANE_KEY` equals the agent's pane key, as with the `self` row that `pause` records), that agent is marked resumed at once with reason `self` and gets no message (even if Orca shows no row for it or a permission prompt), because the session is running the command and a CONTINUE would wait behind it. From any other session, or with an empty `ORCA_PANE_KEY`, the same row gets a CONTINUE like any agent. Re-running `resume` retries only agents that are still pending.

**Record.** The state lives under `$XDG_STATE_HOME/orca-broadcast/` (default `~/.local/state/orca-broadcast/`):

- `lock`: the lock file (see "Safety").
- `current`: a JSON pointer, `{"kind": "pause" | "broadcast", "id": "<id>"}`, to the one open record.
- `pauses/`: one JSON file per pause run.
- `broadcasts/`: one JSON file per broadcast.

Each record is written atomically before every send. At most one record, of either kind, is open. If a crash leaves more than one open, the newest wins and the command reports the others. Running `pause` again before `resume` extends the same run.

**Safety.** The tool never types into a terminal that is not a Claude agent. It never sends to an agent on a permission prompt. It asks for confirmation before it sends. The pane that runs `orca-broadcast` itself is never paused.

One lock covers `broadcast`, `pause`, `resume` and `close`, for the whole run of each command, so two runs cannot overlap. A second command fails at once with "another orca-broadcast is running". `group` commands take no lock. The one exception is the hand-over above, where `pause` stops a broadcast it has proven to be the lock holder.

The `lock` file holds the pid and the start time of its owner. A lock is stale, and the next command takes it over, when its pid is dead or when the pid is alive but has a different start time (the system reused the pid). If a start time is missing, only the pid test applies. A leftover `lock.takeover` file, or a `lock` file that is not readable, is never removed automatically: the command refuses to start and names the file to delete.

## Background work

Orca keeps an agent `working` after its turn ends while background work runs (for example a background shell). The `worktree ps` row of such an agent has `state: "working"` and `mainAgent.state: "done"`. `broadcast` and `pause` show a pending agent in that state with the reason `background` instead of `still-working`. Only the label changes: the status, the exit codes and the proof rules stay the same, so the agent counts only from a new reply that ends with the exact token line. The reason says "background work" because the pair may also match work that is not a shell. `background` needs `mainAgent.state`: a row without `mainAgent` (it is undocumented, and was seen on Claude Code v2.1.296 only) keeps `still-working`, even with `workingMode: "monitoring"`.

## Known limits

- Only Claude Code agents on the local Orca host. Remote hosts and other agent types are not supported.
- Races remain between the last check and a send (an agent can open a dialog in between).
- Whether an agent in the background state handles a message that is sent to it is not tested; the tool does not claim that it will ack or pause.
- A queued broadcast can still be carried out just before a `pause` or a `close` abandons it. An agent that has the message in its queue may handle it while the tool marks it `abandoned`; a late ack on an abandoned target is ignored.
- Machine sleep or reboot is out of scope; the scenario is "machine stays on, you are away" (network loss, a break, end of day or a usage limit).

## Development

```sh
pnpm test        # Vitest; every test uses an in-memory fake Orca
pnpm typecheck
pnpm build
```

Tests must never call a real Orca. Do not run the built CLI against real agents to test it: it sends real messages to every working session.

After pulling changes, run `pnpm build`: the installed command runs `dist/`. Notes for coding agents are in `AGENTS.md`.
