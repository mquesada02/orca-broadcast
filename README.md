# orca-broadcast

`orca-broadcast` pauses every working Claude Code agent in the Orca IDE before you leave, and resumes all of them when you are back. It checks that each agent really stopped or continued, so no agent is missed.

## Requirements

- Linux, with Orca running and its CLI available as `orca-ide`
- Node.js 22 or later, and pnpm
- Agents must be Claude Code sessions on the local Orca host

## Known limits

- It works with Claude Code agents only.
- It works with the local Orca host only.
- It works on Linux only.

For the full limits, see [Known limits](docs/guide/how-it-works.md#known-limits).

## Install

```sh
git clone https://github.com/mquesada02/orca-broadcast.git
cd orca-broadcast
pnpm install
pnpm build
```

Then put the command on your `PATH`. Use `pnpm link --global` or a small wrapper. For `pnpm link --global`, pnpm's global bin directory must be on your `PATH` (see `pnpm setup`).

This is the wrapper:

```sh
printf '#!/bin/sh\nexec node %s/dist/bin.js "$@"\n' "$PWD" > ~/.local/bin/orca-broadcast
chmod +x ~/.local/bin/orca-broadcast
```

After pulling changes, run `pnpm build`: the installed command runs `dist/`.

## Quick start

Run each command from a plain terminal. See [Safety](#safety).

Pause, resume and close:
```sh
orca-broadcast pause                       # before you leave
orca-broadcast resume                      # when you are back
orca-broadcast close                       # abandon a run that can never finish
```
More: [Pause and resume](docs/guide/pause-and-resume.md).

Broadcast the same instruction to every working or done agent:
```sh
orca-broadcast broadcast "back up the /tmp files you need"
orca-broadcast broadcast "stop and push" --repo alpha --role worker   # only some agents
```
More: [Broadcast](docs/guide/broadcast.md).

After a PC restart or an Orca crash, find the agents that did not come back and restart them:
```sh
orca-broadcast recover --repo alpha --role coordinator   # only part of the fleet
```
More: [Recover](docs/guide/recover.md).

Save a snapshot of the live agents. This reads Orca and sends nothing:
```sh
orca-broadcast roster save
```
More: [Roster](docs/guide/roster.md).

Complete commands and flags with Tab in bash. Add this line to `~/.bashrc`:
```sh
eval "$(orca-broadcast completion bash)"
```
More: [Tab completion](docs/guide/reference.md#tab-completion).

## Documentation

| Page | What it holds |
|---|---|
| [Pause and resume](docs/guide/pause-and-resume.md) | `pause`, `resume`, `close` of a pause run, and the pause reasons |
| [Broadcast](docs/guide/broadcast.md) | `broadcast`: text, message, proof, wait, re-run and `close` |
| [Recover](docs/guide/recover.md) | `recover` after a restart or a crash |
| [Roster](docs/guide/roster.md) | The roster of live agents, its files and the timer |
| [Filters and groups](docs/guide/filters-and-groups.md) | The filter flags per command and the saved groups |
| [Reference](docs/guide/reference.md) | Every option, every exit code, Tab completion and `--json` |
| [How it works](docs/guide/how-it-works.md) | Records, the lock, background work and the known limits |

## Safety

`orca-broadcast` asks before it sends. It never types into a terminal that is not a Claude agent. It never sends to an agent on a permission prompt. Run it from a plain terminal, not from inside a Claude session. An agent cannot pause itself while it runs a command.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
