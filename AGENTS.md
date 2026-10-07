# AGENTS.md

This file provides guidance to coding agents (Claude Code and others) when working with code in this repository.

Behaviour: `README.md`. Full design: spec issue #14.

## Never touch real agents

Do not run the built CLI (`node dist/bin.js`, `orca-broadcast`) or any command that sends to real Orca terminals — not even with a temporary `XDG_STATE_HOME`. It messages every working Claude session on the machine; this happened once during development. Verify behaviour only through tests. Copy this rule into the prompt of any subagent you start for this repo.

To capture a real `orca-ide` output shape, send only to a throwaway terminal you create yourself with `orca-ide terminal create`, never through `orca-broadcast`.

## Gotchas

- `main()` in `src/cli.ts` falls back to the **real** `orca-ide` adapter when `deps.port` is omitted. Every test must pass a fake port.
- Agents are identified by `paneKey` (`<tabId>:<leafId>`). Terminal handles go stale; never key anything on a handle.
- Every test must pass a fake `kill`; the test runner's default `kill` throws, so no test can signal a real process. Hand-over tests also pass fakes for the store's pid, liveness and start-time readers.
- Proof comes from Orca state and the agent's last reply (`ORCA-PAUSED <token>`, or a changed reply after CONTINUE), never from send receipts.
- Fixtures in `test/fixtures/` must be redacted copies of real `orca-ide` output. A hand-written send receipt once hid a bug where every real send looked rejected.

## Agent skills

### Issue tracker

Issues and specs are GitHub issues in `mquesada02/orca-broadcast`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
