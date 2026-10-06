# orca-pause

Pause every working Claude Code agent in the Orca IDE before your network drops, and resume all of them when you are back — with proof that none was missed.

`orca-pause pause` asks each agent to finish the step it is on, write a short "where I stopped" note, and wait. It then checks that every agent actually stopped. `orca-pause resume` tells every recorded agent to continue and checks that each one did.

## Requirements

- Linux, with Orca running and its CLI available as `orca-ide`
- Node.js 22 or later, and pnpm
- Agents must be Claude Code sessions on the local Orca host

## Install

```sh
git clone git@github.com:mquesada02/orca-pause.git
cd orca-pause
pnpm install
pnpm build
```

Then put the CLI on your `PATH`, either with `pnpm link --global` (needs pnpm's global bin directory on `PATH`, see `pnpm setup`) or with a small wrapper:

```sh
printf '#!/bin/sh\nexec node %s/dist/bin.js "$@"\n' "$PWD" > ~/.local/bin/orca-pause
chmod +x ~/.local/bin/orca-pause
```

## Usage

Run the commands from a plain terminal, not from inside a Claude session. An agent cannot pause itself while it runs a command.

Before you leave:

```sh
orca-pause pause            # lists the agents, asks "Send to N agents? [y/N]", then waits
orca-pause pause --timeout 3m
```

When you are back:

```sh
orca-pause resume
```

If a run can never finish (for example an agent ignores the message), abandon it:

```sh
orca-pause close
```

### Options

| Option | Effect |
|---|---|
| `--timeout <n>s\|m\|h` | How long `pause` waits for confirmations. Default `10m`. `pause` only. |
| `--yes` | Skip the confirmation prompt. Without an interactive terminal, `pause` and `resume` refuse to send unless you pass it. |
| `--json` | Print one JSON object on stdout and nothing on stderr. It never prompts, so `pause` and `resume` need `--yes`. |
| `--help` | Show help. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | `pause`: every agent confirmed. `resume`: the run closed. Also "nothing to do". |
| `1` | `pause`: at least one agent is unconfirmed. `resume`: at least one agent is still pending. The table says why and what to do. |
| `2` | Usage error, Orca listing failed, refused without `--yes`, or another `orca-pause` is running. |
| `130` | Interrupted (Ctrl-C, SIGTERM, SIGHUP). The record is saved; run the command again. |

## How it works

**Pause.** The tool lists agents with `orca-ide worktree ps` and selects every Claude agent in state `working`. Coordinators (found through `orca-ide orchestration run-list`) are messaged first and also told not to dispatch new work. Each agent gets one message with a random token and must end its reply with `ORCA-PAUSED <token>`. An agent counts as paused only when Orca shows it `done` and its new last reply ends with that exact line — send receipts are never taken as proof. The wait loop also sweeps up agents that start working later and re-pauses an agent that wakes up once.

**Resume.** The tool finds each recorded agent again by its Orca pane key, skips agents on a permission prompt, and sends `[orca-pause] CONTINUE …`. An agent counts as resumed when its state or last reply changes after the message (or, if it was still working, once Orca accepts the queued message). Workers are continued before coordinators. Re-running `resume` retries only agents that are still pending.

**Record.** Each run is stored as JSON in `$XDG_STATE_HOME/orca-pause/` (default `~/.local/state/orca-pause/`), written atomically before every send. Running `pause` again before `resume` extends the same run.

**Safety.** The tool never types into a terminal that is not a Claude agent, never sends to an agent on a permission prompt, holds a lock so two runs cannot overlap, and asks for confirmation before sending. The pane running `orca-pause` itself is never paused.

## Known limits

- Only Claude Code agents on the local Orca host. Remote hosts and other agent types are not supported.
- Races remain between the last check and a send (an agent can open a dialog in between).
- An agent kept `working` by a background shell never confirms.
- Machine sleep or reboot is out of scope; the scenario is "machine stays on, network drops".

## Development

```sh
pnpm test        # Vitest; every test uses an in-memory fake Orca
pnpm typecheck
pnpm build
```

Tests must never call a real Orca. Do not run the built CLI against real agents to test it: it sends real messages to every working session.

After pulling changes, run `pnpm build`: the installed command runs `dist/`. Notes for coding agents are in `AGENTS.md`.
