# Windows and macOS

orca-broadcast runs only on Linux.

## Why this is out of scope

Two parts of the tool read `/proc`:

- The lock and the store prove that a process is still the one that wrote a record by its pid and its process start time. The start time reader is Linux-only.
- `recover` and the roster find each Claude Code session ID by a scan of `/proc` joined to `~/.claude/sessions/`.

Other platforms would need a second implementation of both, and tests for each.

The specs #84 and #127 already listed this as out of scope.

## Prior requests

- None.
