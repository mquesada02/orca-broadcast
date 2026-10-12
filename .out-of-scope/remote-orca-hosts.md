# Remote or paired Orca hosts

orca-broadcast works only with agents on the local Orca host. Agents on remote or paired Orca hosts are not targeted.

## Why this is out of scope

The tool is built around one machine:

- The record store and the lock live in local directories (`~/.local/state/orca-broadcast/`), and the lock holds a local pid and process start time.
- `pause` can stop a waiting `broadcast` by signalling its local process. A process on another host cannot be proven or signalled this way.
- The adapter refuses any `orca-ide` listing that omits the local host, and it never asks for other hosts.

Supporting other hosts would need a design for a shared store and lock, cross-host proof of the running command, and research on how `orca-ide` lists and sends to remote terminals. The maintainer uses one PC, so this cost buys nothing today.

The specs #14 and #61 already listed this as out of scope.

## Prior requests

- #98 — "Support remote or paired Orca hosts"
