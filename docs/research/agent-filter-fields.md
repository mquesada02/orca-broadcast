# Research: which Orca fields identify an agent's repo, worktree, role and run

Ticket: #51. Snapshot taken 2026-10-06, read-only. Personal paths, names and objectives are redacted below.

Sources (cited as [S1]..[S6]):
- [S1] `orca-ide skills get orca-cli`, `orca-ide skills get orchestration`
- [S2] `orca-ide worktree ps --help`, `worktree show --help`, `worktree create --help`, `orchestration --help`, `orchestration run-list|run-show|run-current|worker-list|worker-show|task-list --help`
- [S3] live `orca-ide worktree ps --json` (40 worktrees, 20 `claude` agents), `terminal list --json` (19 terminals), `repo list --json` (21 repos)
- [S4] live `orca-ide orchestration run-list --json` (34 runs), `run-show --id <run> --json`, `worker-list --json` (all 916 dispatches, paged through `page.nextCursor`)
- [S5] repo code: `src/orca-adapter.ts`, `src/shared.ts`, `src/pause.ts`
- [S6] fixtures `test/fixtures/{worktree-ps,terminal-list,run-list}.json`
- Prior note: `docs/research/terminal-identity.md` on branch `mquesada02/research-terminal-identity` (paneKey to terminal join).

## Direct answer

1. **Repo, worktree: read from `worktree ps` itself.** Each agent sits in `result.worktrees[i].agents[j]`; the owning worktree row carries `repoId`, `repo`, `worktreeId`, `path`, `displayName`, `branch`, `worktreeInstanceId`. The agent row has none of these. [S3] [S6 worktree-ps.json] The adapter already does this walk (`src/orca-adapter.ts:99-117`).
2. **Role and run need two more commands; `worktree ps` has neither.** `agents[]` fields are only `paneKey, parentPaneKey, state, agentType, prompt, taskTitle, displayName, lastAssistantMessage, toolName, toolInput, interrupted, stateStartedAt, updatedAt`. [S6] No role, no run id. The chain is:
   `agents[].paneKey` -> `terminal list` `result.terminals[]` where `tabId + ":" + leafId == paneKey` -> `.handle` -> match against:
   - coordinator: `orchestration run-list` `result.runs[].coordinator_handle == handle`, then run id is `result.runs[].id` [S4] [S5 `src/orca-adapter.ts:136-139`]
   - worker: `orchestration worker-list` `result.workers[].agentTerminalHandle == handle`, then run id is `result.workers[].runId` (also `projection.runId`) and role is `result.workers[].projection.role` (only value seen: `"worker"`) [S4]
3. **Role "coordinator" is "owns a run's `coordinator_handle`", "worker" is "owns a dispatch's `agentTerminalHandle`". Neither is a field on the agent.** An agent matching neither is a plain session (8 of the 14 live claude agents in this snapshot). [S3][S4]
4. **`parentPaneKey` is a weak worker signal that agreed with `worker-list` here.** It was set on exactly the 2 live workers, and each resolved (via terminal list) to the coordinator terminal of the same run that `worker-list` reported. [S3][S4] It is not documented as a role/run field, so use it only as a cross-check. The pre-existing note found the parent pane lives in a different worktree than the child's `parentWorktreeId` names (coordinator panes sit in the repo main checkout), so the lineage fields `parentWorktreeId`/`parentWorktreeInstanceId` do **not** identify the run. [terminal-identity.md] Here too: both workers' worktrees have `parentWorktreeId != null` while their coordinators were all in main checkouts (4 of 4). [S3][S4]

## Field map

| Need | Command | JSON path | Join to |
|---|---|---|---|
| repo id | `worktree ps` | `result.worktrees[].repoId` | `repo list` `result.repos[].id` |
| repo name | `worktree ps` | `result.worktrees[].repo` (equals `repo list` `result.repos[].displayName` in 40/40 rows) | |
| repo path | `repo list` | `result.repos[].path` (no path on the `ps` row; `ps` `path` is the worktree path) | by `repoId` |
| worktree id | `worktree ps` | `result.worktrees[].worktreeId` = `<repoId>::<path>` (40/40) | `terminal list` `result.terminals[].worktreeId` |
| worktree path | `worktree ps` | `result.worktrees[].path` | `terminals[].worktreePath` |
| worktree name | `worktree ps` | `result.worktrees[].displayName` | |
| worktree instance | `worktree ps` | `result.worktrees[].worktreeInstanceId` (also `worktree create` result `worktree.instanceId` and `identity.key`) | |
| agent -> terminal | `terminal list` | `result.terminals[].tabId` + `":"` + `leafId` | `agents[].paneKey` |
| terminal handle | `terminal list` | `result.terminals[].handle` | `run-list`/`worker-list` |
| coordinator of run | `orchestration run-list` | `result.runs[].coordinator_handle`, `.id` | terminal `handle` |
| worker's run | `orchestration worker-list` | `result.workers[].agentTerminalHandle`, `.runId`, `.projection.role`, `.projection.runId` | terminal `handle` |
| run -> workspace | `worker-list` | `result.workers[].projection.workspace.id`, `.resource.worktreeId` | `worktreeId` (286 and 268 of 916 matched a current `ps` row; the rest are released/deleted worktrees) |

Join status in this snapshot [S3][S4]: 20 claude agents (14 done, 5 working, 1 waiting); 14 had a terminal, all in the same `worktreeId` as the agent row; 6 `done` rows had none. Of the 14 with a terminal: 4 coordinators, 2 workers, 8 neither; 0 both; 0 in more than one run.

## Ambiguous, missing or unstable

- **Legacy/ownerless runs.** 3 of 34 runs have `coordinator_handle: null` (`run_legacy_local` with `legacy: 1`, and two non-legacy runs). They can never match an agent. A naive `Map<handle, runId>` keyed on `coordinator_handle` collapses them onto the key `null`/`undefined`; skip null. [S4] The adapter at `src/orca-adapter.ts:139` passes `run.coordinator_handle` through unchecked.
- **Coordinator of a finished run.** `run-list` has no status field (keys: `consumer_generation, coordinator_handle, created_at, id, legacy, objective, updated_at`). Only 4 of 34 `coordinator_handle`s still match a live terminal; the other 30 are stale or null. A run being "finished" is not expressible; "coordinator terminal alive" is the only usable signal. [S4]
- **Worker without a run.** Not observed: all 916 `worker-list` rows have a `runId` and a handle. A `claude` agent that was not started through orchestration (a user-launched session) simply has no `worker-list` row. Dispatches created with `orchestration dispatch` (context-only) are listed as unsupervised, so the same terminal may appear there too. [S2 worker-list notes] [S4]
- **Agent in two runs.** Not observed (0 of 14 live, 0 handles shared across runs). It is possible in principle: `worker-list` is per dispatch, and a terminal can be reused for more than one dispatch (orchestration skill mentions same-terminal reuse [S1]). Handle: collect the set of run ids, and if more than one, treat as ambiguous; do not pick one silently.
- **`worker-list` is paged and history-heavy.** 916 rows, default page 100 newest first, `page.hasMore`, `page.nextCursor`; 629 are `terminalState: released`. A filter must page to the end or filter server-side with `--terminal-state active` (2 rows; matches the 2 live workers) or `--run <id>`. Without `--run` the scope is the Run bound to the calling terminal, else all (`scope.source` = `flag|bound|all`). Calling it from a bound coordinator terminal narrows the result silently. [S2][S4]
- **Terminal handles are runtime-scoped.** [S1] "Handles are runtime-scoped: after an Orca restart ... re-list." So `coordinator_handle` and `agentTerminalHandle` are stored handles that can go stale across a restart (30 of 34 run coordinators already do not resolve). Whether Orca rewrites them on restart is **unverified** (restart forbidden). Always re-resolve through a fresh `terminal list` and never persist role/run as identity.
- **Truncation.** `worktree ps` and `terminal list` carry `truncated` and `hostScope.omittedHostIds`; the adapter already refuses incomplete listings (`src/orca-adapter.ts:88-93`). `worker-list` does not use that shape: check `page.hasMore`.
- **`repo` on `ps` rows is the repo display name, not a key.** In this snapshot names were unique (21 names = 21 ids, `repo list` has 0 duplicate `displayName`), but `repo add` takes a path and the name is user-editable metadata, so uniqueness is not guaranteed. [S3][S1 repo commands]
- **Worktree `displayName` is not unique across repos.** 17 of 40 rows share a name (21 main checkouts split into groups of 16 and 3 with the same name); unique per `repoId` here (0 collisions within a repo), unverified as a rule. `path` was unique 40/40 and `worktreeId == repoId + "::" + path` 40/40. [S3]
- **Id/path stability.** `worktreeId` embeds the path, so a moved or recreated checkout changes it; `worktreeInstanceId` is a separate UUID present on 40/40 rows. Persistence of `worktreeInstanceId`, `tabId`/`leafId` across restart is **unverified**. [S3]

## Recommended identifiers for filter values

Resolve each kind to an id first, match on the id, and accept friendly forms only as input sugar.

| Kind | Match on | Why | Accept as input |
|---|---|---|---|
| repo | `repoId` (`repo list` `id`, `ps` `repoId`) | never ambiguous; name is editable and path is not on the `ps` row | `repo` name (resolve through `repo list`; error if more than one id has it), absolute path via `repo list` `path` |
| worktree | `worktreeId` (`<repoId>::<path>`); this is exactly the selector form `id:<repoId>::<path>` Orca documents [S1] and what the adapter already stores (`AgentRow.worktreeId`) | unique 40/40, repo-scoped, same value on `ps` and `terminal list` | absolute `path` (unique, 1:1 with the id), `displayName` only together with a repo (it collides across repos) |
| run | run id `run_<hex>` (`run-list` `id`, `worker-list` `runId`) | the only run identifier; stable per run and never reused in the snapshot | none (objective is free text) |
| role | derived: coordinator iff handle in a non-null `coordinator_handle`; worker iff handle in `worker-list` `agentTerminalHandle` | no role field exists | `coordinator`, `worker` |

Notes for implementation (inference): derive role and run from one fresh pass of `terminal list` + `run-list` + `worker-list --terminal-state active` per invocation, key by `paneKey`, and compute a set of run ids per agent. Treat a handle matched by more than one run as ambiguous. Never key anything on a handle across calls.

## Open questions (unverified)

1. Do `coordinator_handle` / `agentTerminalHandle` values survive an Orca restart or get rewritten? Restart forbidden.
2. Can one live terminal be in more than one run (dispatch reuse)? Not seen.
3. What other values can `projection.role` take besides `worker`? Only `worker` appeared in 916 rows.
4. Is a repo `displayName` guaranteed unique, and is a worktree `displayName` unique per repo? Only observed.
5. Does `worker-list --terminal-state active` include a worker whose terminal is alive but whose dispatch is `ready` or `abandoned`? Observed counts: workerState `ready` 2, `abandoned` 2 in the first page; not cross-checked against live terminals beyond the 2 active rows.
