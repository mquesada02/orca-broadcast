# Roster

The roster is a set of snapshots of the live Claude agents. The roster keeps one file per Orca runtime. A later command can then find the agents that were alive before a restart. `recover` reads it. See the term [Roster](../../CONTEXT.md).

`roster save` reads Orca and sends nothing, so it has no token line. It takes no lock. See [The lock](how-it-works.md#the-lock). It touches only the `roster/` folder of the state folder.

## What the roster holds

The roster lists the Claude agents that have a live pane. It holds one entry per Claude session ID. If two live panes hold the same session ID, the newest process keeps the entry.

An entry never holds prompt or reply text. These are its fields:

| Field | Meaning | Present |
|---|---|---|
| `sessionId` | The Claude session ID. | Always |
| `paneKey` | The pane key of the agent. | Always |
| `repo` | The repo name. | Always |
| `repoId` | The repo ID. | Always |
| `worktree` | The worktree name. | Always |
| `worktreeId` | The worktree ID. | Always |
| `worktreePath` | The worktree path. | Always |
| `role` | `coordinator`, `worker` or `session`. | Always |
| `orchestrationRunIds` | The IDs of the orchestration runs of the agent. | Always |
| `state` | The last state: `working`, `done` or `waiting`. | Always |
| `stateStartedAt` | When the agent entered that state. | Always |
| `savedAt` | The time of the save that wrote the entry. | Always |
| `coordinatorSessionId` | The session ID of the coordinator of a worker. | Worker only, when known |
| `dispatchId` | The dispatch ID of a worker. | Worker only, when known |
| `permission` | The permission flag of the Claude process. | When known |

## When the tool saves it

`roster save` writes one snapshot now. It takes one listing and one scan of the Claude processes.

These commands also save the roster. Except for the end save of `recover`, they use listings that they already take:

| Command | Saves |
|---|---|
| `broadcast`, `resume` | Once the run has taken its first listing, and at its end. |
| `pause` | Once the run has taken its first listing and resolved its filters and groups, and at its end. |
| `recover` | At its start. At its end, when it started agents. |

A run that stops before that point saves nothing. An example is `resume` with no open pause run, or a `broadcast` that finds an open pause run.

Each save costs at most one extra scan of the Claude processes. No save runs while a command waits, so no save takes a scan then. The `recover` start save reuses the scan that `recover` already took.

The end save of `broadcast`, `pause` and `resume` writes the newest listing of the run. It writes nothing when that listing is the one that the start save used. The end save of `recover` takes its own listing. If that listing fails, `recover` fails and its record stays open. That is not a failed save.

A failed save never fails the command. The warning is `roster not saved: <reason>`. Text mode prints it on stderr, with the prefix `orca-broadcast: `. Under `--json`, the warning goes to the `warnings` field.

A command that has received an interrupt signal saves nothing more.

## Files

The tool writes the roster to this path:

```
$XDG_STATE_HOME/orca-broadcast/roster/<boot ID>-<runtime ID>.json
```

The default folder is `~/.local/state/orca-broadcast/`. See [Records and the state folder](how-it-works.md#records-and-the-state-folder). When Orca gives no runtime ID, the file name uses `none` in its place.

These rules apply to a save:

- A save in the same runtime replaces the entries of that file. The file keeps its `firstSavedAt` time.
- An agent that you closed on purpose drops out at the next save.
- An agent keeps its old entry when its pane is live but the scan could not read its session ID this time.
- A save after a restart writes a new file. It never changes an older file.
- The tool keeps the newest 5 files. It never removes the file that it just wrote.

## Output

`roster save` prints one line on stdout:

| Result | Line |
|---|---|
| Saved | `roster saved: <N> agents` |
| Not saved | `roster not saved: <reason>` |

A failed scan or listing never replaces a saved snapshot.

With `--json`, it prints this object:

```json
{"command":"roster save","outcome":"saved","agents":2,"warnings":[]}
```

When it cannot save, `outcome` is `"skipped"`, `agents` is `null`, and `warnings` holds the reason. See [JSON output](reference.md#json-output).

Exit codes: `0` saved, `1` not saved, `2` usage error. See [Exit codes](reference.md#exit-codes).

## Example

Save the roster now:

```sh
orca-broadcast roster save
```

```
roster saved: 2 agents
```

## Keep a recent roster with a timer

A systemd user timer can save the roster every 5 minutes. A crash long after your last command then still finds a recent roster. This step is optional.

1. Create the file `~/.config/systemd/user/orca-broadcast-roster.service`. The `PATH` line must hold the folder of `orca-ide`. Change `%h/.local/bin` if yours is elsewhere.

   ```ini
   [Unit]
   Description=Save the orca-broadcast roster

   [Service]
   Type=oneshot
   Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
   ExecStart=%h/.local/bin/orca-broadcast roster save
   ```

2. Create the file `~/.config/systemd/user/orca-broadcast-roster.timer`.

   ```ini
   [Unit]
   Description=Save the orca-broadcast roster every 5 minutes

   [Timer]
   OnStartupSec=1min
   OnUnitActiveSec=5min

   [Install]
   WantedBy=timers.target
   ```

3. Start the service once by hand, and read the journal. Nobody has tested this unit text under systemd. Check it before you rely on the timer.

   ```sh
   systemctl --user daemon-reload
   systemctl --user start orca-broadcast-roster.service
   journalctl --user -u orca-broadcast-roster.service
   ```

4. Turn the timer on:

   ```sh
   systemctl --user enable --now orca-broadcast-roster.timer
   ```

To turn the timer off:

```sh
systemctl --user disable --now orca-broadcast-roster.timer
```

To change the interval, edit `OnUnitActiveSec` in the timer file. Then run `systemctl --user daemon-reload`.

A save that fails exits `1`. It shows in `journalctl --user -u orca-broadcast-roster.service`.

## The runtime ID caveat

The design relies on the Orca runtime ID changing at every Orca start. Nobody has tested whether Orca keeps it across an Orca-only crash.

If Orca keeps it, a save after the crash writes to the same file as before it. Then only a changed boot ID (a PC restart) protects the earlier snapshot.
