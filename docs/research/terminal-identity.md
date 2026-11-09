# Research: how the CLI identifies one agent's terminal reliably

Ticket: #4 (part of map #2). Snapshot taken 2026-10-05, read-only.

Sources (cited as [S1]..[S5]):
- [S1] `orca-ide skills get orca-cli` (the Orca CLI guide)
- [S2] `orca-ide terminal --help`, `terminal list|show|send|wait|read --help`, `worktree ps --help`
- [S3] `orca-ide agent-context` and `--json` (239 commands, schema v1; contains no text on handle/tab/leaf stability)
- [S4] live `orca-ide worktree ps --json` (35 agents, 20+ worktrees), `terminal list --json` (38 terminals, `truncated:false`), `terminal list --json --include-visual-layouts`, `terminal show --json`
- [S5] one live `terminal show --terminal term_doesnotexist --json` (read-only; used to see the error shape)

## Direct answer

1. **`paneKey` -> terminal is a clean 1:1 join key.** `paneKey` = `<tabId>:<leafId>`; join it to `tabId + ":" + leafId` of `terminal list --json`. In the live data every one of the 10 `working` agents and 23 of 35 total matched exactly one terminal, with the same worktree. No terminal key was duplicated, no `paneKey` was duplicated. [S4] The guide never states the format; it is an observation. The `<tabId>:<leafId>` format is given in the map's Notes (#2) and confirmed by [S4].
2. **Not every agent row has a terminal.** 12 of 35 `agents[]` rows matched nothing. All 12 were `state: done`, last updated 1 to 12 days earlier, in worktrees with `liveTerminalCount: 0` and `hasAttachedPty: false`. Treat these as stale history rows, not live agents. All `working` agents had a terminal. [S4] So: always filter on `state == working` first, then join; a `working` agent with no match should be reported as an error (never seen live; unverified whether it can happen, for example mid-restart).
3. **Two or more Claude agents in one worktree are mapped correctly.** Live examples: one worktree with 5 agents, one with 3, one with 2 (all `claude`). Each agent had its own distinct `<tabId>:<leafId>` and its own terminal; `liveTerminalCount` equalled the number of terminals listed for each worktree. [S4] Therefore the key must be `paneKey`, never "the agent/terminal of worktree X".
4. **Stability across restart: only the handle is documented as unstable.** The guide says: "Handles are runtime-scoped: after an Orca restart or a `terminal_handle_stale` error, re-list and continue with the replacement only; never dual-send to old and replacement handles." [S1] The CLI help calls it "Runtime-issued terminal handle". [S2] Nothing in [S1]-[S3] says whether `tabId`, `leafId`, `ptyId` or `incarnationId` survive a restart. **Unverified** (restarting Orca was forbidden). See the table below.
5. **To re-find a terminal after its handle goes stale:** re-run `terminal list --json` and look up by `tabId`+`leafId` (the recorded `paneKey`). If that no longer matches (see open questions), fall back to `worktreeId` plus `agentIdentity == claude`, accepting only a single unambiguous candidate. Use the replacement handle only, never both. [S1 for the re-list rule; the key lookup is our inference]
6. **`parentPaneKey` does not matter for pause/resume.** It is the pane of the agent that spawned this one (the coordinator), not an identity of this agent. [S4] Do not use it to find or order terminals.

## Stability table

| Field | Evidence | Stable across restart / stale handle? |
|---|---|---|
| `handle` (`term_<uuid>`) | [S1] runtime-scoped; [S2] "Runtime-issued"; [S5] unknown handle returns `terminal_handle_stale` | No (documented). Re-list. |
| `tabId`, `leafId` (UUIDs) | [S4] equal `paneKey` halves; also appear in `visualLayouts` pane topology | Unverified. They are UI layout ids stored with the tab layout. [S1] says terminal tabs/layouts are "durably" kept until `terminal close --all`, which suggests persistence, but that is not a statement about ids. |
| `ptyId` (`<repoId>::<path>@@<8hex>`) | [S4] unique per terminal, 38/38 | Unverified. |
| `incarnationId` (UUID) | [S4] unique per terminal; [S2] `send --retry-request` "is bound to the prompt payload and exact terminal process incarnation" | Meaning is a process-instance id; expected to change when the PTY process is replaced. Unverified for restart. Do not use as an identity key. |
| `agentIdentity` | [S4] `claude` on 24 terminals; absent on shells | Not a unique key; use only as a filter. |

## Evidence

Join script ran on the saved JSON (no mutation). Results [S4]:

- terminals 38, unique handles 38, unique ptyIds 38, unique incarnationIds 38, duplicate `tabId:leafId` 0.
- Every terminal sits in its own tab (0 tabs with more than one leaf), so `tabId` alone was also unique in this snapshot; still use the pair.
- agents 35 (10 `working`, 25 `done`, all `claude`); matched 23, unmatched 12; matched terminals in a different worktree than the agent row: 0; duplicate `paneKey`: 0.
- Unmatched rows: all `done`, all in worktrees with `liveTerminalCount: 0`.
- Multi-agent worktrees: 5, 3 and 2 agents; all matched 1:1 with distinct handles.
- `liveTerminalCount` in `worktree ps` matched the per-worktree terminal count from `terminal list` in every worktree.
- `parentPaneKey` present on 6 agents; all 6 resolve to a terminal in a different worktree and to another agent row in `worktree ps`. In all 6 cases the parent pane sat in a repo main checkout while the child's `parentWorktreeId` named a different coordinator worktree, so the pane link and the worktree lineage are separate concepts.
- Orphaned terminal: 1 terminal had `orphaned: true`, with a synthetic `tabId` and `leafId` of the form `pty:<ptyId>` (a PTY with no UI tab). It would never match a `paneKey`. A `paneKey` of that form should be treated as unresolvable by tab/leaf.
- `terminal show --json` returns `result.terminal` with: agentIdentity, agentWait, branch, connected, executionHostId, handle, incarnationId, lastOutputAt, leafId, orphaned, paneRuntimeId, ptyId, rendererGraphEpoch, tabId, title, worktreeId, worktreePath, writable (and `preview`, omitted here). `paneRuntimeId` and `rendererGraphEpoch` are undocumented in [S1]-[S3].
- Stale error shape [S5]: `{"ok":false,"error":{"code":"terminal_handle_stale","message":"terminal_handle_stale"}}`.
- `terminal list` has `topologyRevisions` per worktree and `--include-visual-layouts` for tab/pane topology. [S2][S4]
- `worktree ps` rows are per host, and `trunc` / `scope:` notes say a host may not be covered. [S2] Both lists were `truncated:false` here.

## Recommended identity rule for pause/resume (inference)

Record `paneKey`, `worktreeId`, and the `handle` at pause time. On resume: re-list terminals, resolve by `paneKey`; if the handle is stale or changed, use the replacement handle found under the same `paneKey`; if no terminal matches, report that agent as not resumable instead of guessing. Do not store `incarnationId` as identity. Send through exactly one handle.

## Open questions (unverified)

1. Do `tabId`/`leafId` survive an Orca restart? Needs a restart test or Orca source; not tested because restarts were forbidden. Docs are silent.
2. Does `ptyId` survive restart (for example daemon-held PTYs)? Unknown.
3. Can a `working` agent ever lack a terminal (during restart or a closed tab)? Never observed.
4. Do stale `done` rows in `worktree ps` expire? Unknown; the oldest seen was 12 days.
5. Is `incarnationId` renewed on `claude --resume` inside the same PTY? Unknown.
6. Meaning of `paneRuntimeId` and `rendererGraphEpoch` (possibly a restart/renderer-reload signal). Undocumented.
