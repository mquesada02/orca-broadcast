# AGENTS.md

This file provides guidance to coding agents (Claude Code and others) when working with code in this repository.

Behaviour: `README.md` and `docs/guide/`. Terms: `CONTEXT.md`. Decisions: `docs/adr/`.

## Never touch real agents

Do not run the built CLI (`node dist/bin.js`, `orca-broadcast`) or any command that sends to real Orca terminals — not even with a temporary `XDG_STATE_HOME`. It messages every working Claude session on the machine; this happened once during development. Verify behaviour only through tests. Copy this rule into the prompt of any subagent you start for this repo.

The one exception is help: `orca-broadcast --help` and `orca-broadcast <command> --help`, with no other flag or argument.

To capture a real `orca-ide` output shape, send only to a throwaway terminal you create yourself with `orca-ide terminal create`, never through `orca-broadcast`.

## Gotchas

- `main()` in `src/cli.ts` falls back to the **real** `orca-ide` adapter when `deps.port` is omitted. Every test must pass a fake port.
- Agents are identified by `paneKey` (`<tabId>:<leafId>`). Terminal handles go stale; never key anything on a handle.
- A restart changes every `paneKey`. Across a restart, agents are matched by Claude session ID (ADR 0002): a `paneKey` only joins a live row to its scan record, and finds the agents of a run that has no session ID. Never match a restored agent on `paneKey` alone.
- Every test must pass a fake `kill`; the test runner's default `kill` throws, so no test can signal a real process. Hand-over tests also pass fakes for the store's pid, liveness and start-time readers.
- `createOrcaAdapter(exec)` scans the real `/proc` and `~/.claude` in `scanSessions()` and `startAgent()`. Every test that calls them passes the options argument with a fixture `/proc` root, a Claude Code folder and a uid, built in a temporary folder (`scanOptions()` in `test/helpers/scan-options.ts`). This includes every test that runs `broadcast`, `pause` or `resume` through `createOrcaAdapter(exec)`, because those commands scan when they save the roster.
- Proof comes from Orca state, the agent's last reply and the Claude transcript, never from send receipts (ADR 0004). A token line (`ORCA-PAUSED <token>` or the ack line) proves when it is the last line of Orca's new last reply, or of any transcript reply that ended a turn since the send, also when later turns follow. A resume is proven by the CONTINUE user entry in the transcript; without a readable transcript, by a changed state or reply after CONTINUE.
- Fixtures in `test/fixtures/` must be redacted copies of real `orca-ide` output. A hand-written send receipt once hid a bug where every real send looked rejected.

## Research notes

Save each research note as `docs/research/<topic>.md`, on a branch that merges to `main` through a PR. A note left only on its own research branch gets lost. Redact live output before you commit it: no home paths, user names, or names and IDs from other projects.

## Agent skills

These files configure the mattpocock/skills agent skills that the maintainer uses.

### Issue tracker

Issues and specs are GitHub issues in `mquesada02/orca-broadcast`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
