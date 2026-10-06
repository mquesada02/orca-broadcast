# AGENTS.md

This file provides guidance to coding agents (Claude Code and others) when working with code in this repository.

`orca-pause` is a Node/TypeScript CLI that pauses every working Claude Code agent in the Orca IDE (via the `orca-ide` CLI) and later resumes them, proving each step. The user-facing behaviour is in `README.md`; the full design is spec issue #14.

## Never touch real agents

Do not run the built CLI (`node dist/bin.js`, `orca-pause`, `pnpm start`) or any command that sends to real Orca terminals — not even with a temporary `XDG_STATE_HOME`. It messages every working Claude session on the machine; this happened once during development. Verify behaviour only through tests. Copy this rule into the prompt of any subagent you start for this repo.

To capture a real `orca-ide` output shape, send only to a throwaway terminal you create yourself with `orca-ide terminal create`, never through `orca-pause`.

## Commands

```sh
pnpm install
pnpm build                       # tsc -p tsconfig.build.json -> dist/
pnpm typecheck                   # tsc --noEmit (includes tests)
pnpm test                        # vitest run
pnpm test test/pause.test.ts     # one file
pnpm test -t "re-woken"          # tests whose name matches
```

There is no linter. Node >= 22, ESM, no runtime dependencies (only `node:` built-ins).

## Architecture

- **One seam to Orca.** `OrcaPort` (`src/types.ts`) has four operations: `listAgents` (`worktree ps`), `listTerminals` (`terminal list`), `listRuns` (`orchestration run-list`, all pages) and `send` (`terminal send --enter`). `src/orca-adapter.ts` is the only code that runs `orca-ide`; it maps raw JSON into these types and treats `truncated`, a local host in `hostScope.omittedHostIds`, or bad JSON as errors.
- **Commands are pure-ish functions over injected deps.** `pause(timeoutMs, PauseDeps)`, `resume(ResumeDeps)` and `close(store)` take the port, a `Clock`, the `RecordStore`, an optional `confirm`, the self pane key and an `AbortSignal`, and return a `RunSummary`. They never touch `process`, the real clock or the filesystem directly.
- **`src/cli.ts` is the shell.** `main(argv, env, io, deps)` parses flags, applies the `--yes`/TTY refusal gate, wraps the command in `withLockAndSignals` (`src/guard.ts`: lock file + SIGINT/SIGTERM/SIGHUP → save and exit 130), renders tables or one `--json` object, and maps the summary to exit codes 0/1/2/130. `src/bin.ts` only wires `process`. If `deps.port` is omitted, `main` uses the **real** adapter — tests must always pass a fake.
- **State lives in `src/store.ts`.** One JSON file per run plus a `current` pointer in `$XDG_STATE_HOME/orca-pause/`, written atomically (temp file + rename) before every send and after every poll. `findOpenRun` trusts the run's `status` over the pointer.
- **Identity is the pane key.** Agents are keyed by `paneKey` (`<tabId>:<leafId>`), joined to terminals by `tabId:leafId`; terminal handles are only hints and go stale. `locate()` in `src/shared.ts` is the shared rule that decides `gone` (`terminal-closed`, `terminal-orphaned`, `agent-missing`, `agent-exited`). A fresh `terminal list` + `worktree ps` is read right before every send, and nothing is sent to a non-Claude terminal or a `waiting` agent.
- **Pause is a per-poll state machine** (`src/pause.ts`): every 2 s it refreshes listings and roles, sweeps new `working` agents, runs the wake check on confirmed agents, re-checks unconfirmed ones, then delivers pending messages (coordinators first). Proof of pause = state `done` + a reply different from `pauseBaseline` whose last line is exactly `ORCA-PAUSED <token>`. A second `pause` on an open run extends it (same token) instead of starting a new one; the pane running `orca-pause` ("self", from `ORCA_PANE_KEY`) is recorded but never messaged.
- **Resume proof** (`src/resume.ts`) compares a stored `continueBaseline` (`stateStartedAt` + last reply) after the send; an agent still `working` counts as resumed once Orca accepts the queued message. Workers are sent before coordinators.
- **Retries and aborts.** List calls go through `withRetry` (`src/retry.ts`, 3 attempts). Long waits use `sleepOrAbort`/`throwIfAborted` (`src/abort.ts`) so signals stop work between steps.

## Tests

- `test/helpers/fake-orca.ts` provides `FakeOrca` (an `OrcaPort` whose agents follow scripted `Behavior`s and record every send), `fakeClock` (instant sleeps) and `tempStateDir`. `test/helpers/run-cli.ts` runs `main` with these fakes and a scripted prompt answer.
- Adapter tests feed real captured `orca-ide` output from `test/fixtures/` through a fake `exec`. Fixtures must be redacted copies of real output (see `test/fixtures/README.md`); a hand-written receipt once hid a bug where every real send looked rejected.

## Agent skills

### Issue tracker

Issues and specs are GitHub issues in `mquesada02/orca-pause`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
