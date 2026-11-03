# Where to find the agents that were alive before a crash

Research for issue #122, a ticket of the map #120 (Recover agents after a restart). Captured 2026-10-12 (local time, UTC-3) on Linux with the Orca build in `~/.cache/orca/appimage/` (`app.asar` dated Oct 8). The CLI is `orca-ide`.
No `src/` or test change. Two sibling tickets answer the identity questions (#121, #123); this note does not.

## Answer in short

1. The best source is Orca's own record of agent sessions: the `workspaceSession.sleepingAgentSessionsByPaneKey` document in `~/.config/orca/profiles/local-default/profile-state.db`. Per agent it holds `paneKey`, `worktreeId`, `agent`, the Claude session ID (`providerSession.id`), `state`, `capturedAt`, `updatedAt` and sometimes `launchConfig`. It has **no role** and no worktree path (the path is the tail of `worktreeId`).
2. It is only useful **if read before the restored Orca rewrites it**. After the restart of 2026-10-12 no entry for an agent that was alive at the restart remains in the live store, apart from one `quit` entry; there is no copy for 10-12. For 2026-10-09 the only pre-crash copy is `orca-data.json` (and the identical export 48781), a file that appears to be a copy of an export made at that moment (same size as `orca-data.json.sqlite-export.48781.json`) and is no longer updated. Other exports exist for 09-29, 09-30 and 10-06. The `quit` marks and these exports appear to be written at an **Orca app exit** (trigger unconfirmed, see source A), so they are not shown to exist after a hard kill or a power loss. A tool that starts after the restart cannot count on any of this.
3. Therefore the tool should keep **its own roster** and refresh it while Orca is healthy (the roster itself is untested against a real crash). The hourly backups of Orca's store are a possible second source for a crash found within about 5 hours; this is untested against a real crash. Claude Code's `projects/*.jsonl` files cannot say which sessions were alive, and `sessions/<pid>.json` is untested for a crash.
4. The roster that the tool saves misses: any agent started after the last save, and a role that the tool did not see. See the [Recommendation](#recommendation).

## Method

Read only, in these ways:

- Listings: `orca-ide worktree ps --json`, `orca-ide terminal list --json`.
- Files on disk, opened with Python (`python3 -I`, `sqlite3` in `mode=ro` on a **copy** of the database plus its `-wal` and `-shm` files).
- File names and modification times of Claude Code session files. **No session file was opened.** Message fields (`prompt`, `lastAssistantMessage`, `toolInput`) were not printed in this note; the commands print only field names, types, counts and times.
- The Orca program bundle (`app.asar`), searched as bytes, to read the code that writes the record.

Not done, by the safety rules: no terminal was created, written to, read or waited on; `orca-broadcast` and `node dist/bin.js` were not run; Orca was not restarted. A real restart or crash was not provoked. What each source holds *after a restart* is therefore taken from the two real events, not from a controlled test.

Redaction: ids (`paneKey`, `tabId`, `worktreeId`, session IDs), paths and message text are replaced by placeholders. Counts and times are real. Times are local (UTC-3). The Orca daemon log and the orchestration database use UTC.

### The two events

| Event | Evidence for the time |
|---|---|
| "Crash" (as named in the map), 2026-10-09 | The daemon log has no `shutdown` event. The last daemon event before the new daemon is `2026-10-09T17:38:56Z` (14:38:56). The new daemon logs `startup` at `17:39:28Z` (14:39:28). |
| PC restart, 2026-10-12 | `last -x reboot shutdown`: `shutdown 16:11`, `reboot 16:12`. The new daemon logs `startup` at `2026-10-12T19:13:28Z` (16:13:28). The daemon log has no `shutdown` event after 2026-10-06. |

```sh
python3 -I -c "
import json
rows=[json.loads(l) for l in open('$HOME/.config/orca/logs/daemon.log') if l.startswith('{')]
for st in ('2026-10-09T17:39:28.907Z','2026-10-12T19:13:28.132Z'):
    p=[j for j in rows if j['ts']<st]; print(st, p[-1]['ts'], p[-1]['event'])
print([(j['ts'],j['reason']) for j in rows if j['event']=='shutdown'])"
# 2026-10-09T17:39:28.907Z 2026-10-09T17:38:56.062Z session-attached
# 2026-10-12T19:13:28.132Z 2026-10-12T19:06:16.835Z session-attached
# [('2026-08-17T18:15:44.480Z','SIGTERM'), ('2026-08-19T12:33:53.905Z','SIGTERM'), ('2026-08-23T23:22:26.643Z','idle'),
#  ('2026-09-17T21:27:57.047Z','SIGTERM'), ('2026-09-30T17:39:43.813Z','idle'), ('2026-10-06T14:17:44.334Z','SIGTERM')]
```

(The 10-09 event may have been an orderly exit; see source A. The last daemon event before the 2026-10-12 startup is 19:06Z, 13 minutes before the startup at 19:13Z. The log does not say why. It does not show when the PC went down.)

## The sources

### A. Orca: `sleepingAgentSessionsByPaneKey` (profile database)

**Where.** `~/.config/orca/profiles/local-default/profile-state.db` (SQLite). Table `profile_state_documents`, row `domain = 'workspaceSession'`, JSON key `sleepingAgentSessionsByPaneKey`.

```sh
python3 -I -c "
import sqlite3,json
c=sqlite3.connect('file:<copy of profile-state.db>?mode=ro',uri=True)   # copy db + -wal + -shm first
ws=json.loads(c.execute(\"select payload from profile_state_documents where domain='workspaceSession'\").fetchone()[0])
sl=ws['sleepingAgentSessionsByPaneKey']; print(len(sl)); print(sorted(next(iter(sl.values()))))"
# 40
# ['agent','capturedAt','connectionId','mainAgent','origin','paneKey','prompt','providerSession','state','tabId','terminalTitle','updatedAt','worktreeId']
```

**What one entry holds** (a 2026-10-09 entry, text fields redacted; the keys vary by entry: `mainAgent`, `launchConfig` and `lastAssistantMessage` are optional):

```json
{
 "paneKey": "<uuid>:<uuid>",
 "tabId": "<uuid>",
 "worktreeId": "<uuid>::<path>",
 "agent": "claude",
 "providerSession": { "key": "session_id", "id": "<uuid>", "transcriptPath": "<path>" },
 "connectionId": null,
 "prompt": "<omitted>",
 "state": "working",
 "capturedAt": 1791567539521,
 "updatedAt": 1791566935660,
 "terminalTitle": "<omitted>",
 "lastAssistantMessage": "<omitted>",
 "launchConfig": { "agentCommand": "claude", "agentArgs": "", "agentEnv": {} },
 "origin": "quit"
}
```

| Wanted | Held? | Notes |
|---|---|---|
| Worktree | Yes | `worktreeId` is `<repo uuid>::<absolute worktree path>`. |
| Role | **No** | No role field. The tool's own `role` (see source F) is derived elsewhere. |
| Claude session ID | Yes | `providerSession.id`; `providerSession.transcriptPath` is the path of the Claude session file. |
| Last activity time | Yes | `updatedAt` (ms) is the time of the last agent status change; `capturedAt` is when the entry was written. |
| State | Yes | `working`, `waiting`, `done`. |
| How to start it again | Sometimes | `launchConfig` (`agentCommand`, `agentArgs`, `agentEnv`) on 12 of the 40 entries of the live store (14 of 30 in the 10-09 file). `agentEnv` may hold secrets; do not copy it into a saved roster without a decision. |
| Agent type | Yes | `agent`. 39 `claude`, 1 `grok` (the map puts non-Claude agents out of scope). |

**Completeness after the crash of 2026-10-09.** The file `orca-data.json` (modified 14:39:00) holds 30 entries. 11 have `origin: "quit"`. Their `capturedAt` is 14:38:59 for all 11, and their `updatedAt` is the last status change (between 10-08 11:33 and 14:38:57). 8 of the 11 are `working`, 3 `waiting`. The 11 are the set that Orca marked `quit`: apparently agents it saw as unfinished (`working` or `waiting`) at that moment (the rule is inferred, see below). This is not ground truth. The set is smaller than the 21 `claudeLivePtySessionIds` strings, and the gap is not explained. One of the 11 has `updatedAt` 10-08 11:33 (`waiting`), so it may not have been alive. The other 19 (`origin: "live"`) are old: 18 are `done` and their `updatedAt` is between 08-24 and 10-09 13:13.

```
PRE-CRASH snapshot (orca-data.json, mtime 10-09 14:39:00): the 11 `quit` entries, numbered by their position in the list sorted by updatedAt:
11 quit claude waiting captured 10-09 14:38:59 updated 10-08 11:33:30
20 quit claude waiting captured 10-09 14:38:59 updated 10-09 14:03:28
21 quit claude waiting captured 10-09 14:38:59 updated 10-09 14:08:38
22 quit claude working captured 10-09 14:38:59 updated 10-09 14:10:25
23 quit claude working captured 10-09 14:38:59 updated 10-09 14:27:11
24 quit claude working captured 10-09 14:38:59 updated 10-09 14:28:55
25 quit claude working captured 10-09 14:38:59 updated 10-09 14:29:51
26 quit claude working captured 10-09 14:38:59 updated 10-09 14:33:40
27 quit claude working captured 10-09 14:38:59 updated 10-09 14:38:19
28 quit claude working captured 10-09 14:38:59 updated 10-09 14:38:54
29 quit claude working captured 10-09 14:38:59 updated 10-09 14:38:57
```

(All 11 have a session ID.) All 30 `paneKey` values match a pane in `terminalLayoutsByTabId` of the same file (checked by `tabId:leafId`). The same file also holds `activeWorktreeIdsOnShutdown` (41 worktree IDs) and `terminalPtyIncarnationsByPaneKey`; they were not studied as roster sources.

The pre-crash file also holds `claudeLivePtySessionIds`: a list of 21 strings of the form `<worktreeId>@@<8 hex>` (a worktree plus a terminal id, no session ID, no role). 21 is the number of orphaned terminal records named in the map.

**How stale it can be.**

- `updatedAt` is the last status change, not the last output. A `working` agent that is in a long tool call looks old.
- The `quit` marks are written at the end of a run. On 10-09 `capturedAt` is 3 s after the last daemon event and 29 s before the new daemon started. The other exports show the same pattern: `orca-data.json.sqlite-export.23389.json` (10-06 11:17, with a planned `shutdown 11:17` in `last -x`) holds 5 `quit`/`working` entries; the exports of 09-30 14:38 and 14:39 and of 09-29 hold `quit` entries too. So `quit` marks and exports look like they come from an **Orca app exit**, and the 10-09 event may have been one (with the machine or the process ended soon after). Counter-evidence: the two orderly PC shutdowns of 10-07 (17:41) and 10-12 (16:11) produced no export, and the 10-12 one left only one `quit` mark; the 09-29, 09-30 and 10-09 exports match no PC shutdown in `last -x`, so they look like Orca app quits or relaunches. So even an orderly exit does not reliably give `quit` marks, and nothing here shows that Orca writes one after a hard kill or a power loss. The Orca code that sets `origin: 'quit'` was not located in the minified bundle; the bundle also has other `origin` values (for example `worktree-sleep`) and a periodic capture, which were not studied. The trigger is **not confirmed**.
- Old `live` entries were not seen removed (inference from a few snapshots). Today 9 of the 40 entries have no terminal (`orca-ide terminal list`); their `updatedAt` is between 08-24 and 10-11. A reader must not rely on `origin` alone, and must combine `origin`, `state` and `updatedAt` with another proof of life. `origin` does not mean the same thing in every copy. In the 10-09 file all 8 `working` agents are `quit` and none is `live`. In the 5 hourly backups (all taken while Orca ran normally, after the 10-12 restart) the `working` agents are `live` (8 to 15 per backup) and only 1 stale `waiting` entry is `quit`. So Orca re-marked the unfinished agents as `quit` at the end of the run (an inference from these two views; the rule is not documented), and a periodic capture or backup holds them as `live`. The backups say nothing about what a backup holds around a crash.

**What the restart does to it.** After the PC restart of 2026-10-12, the entries of the 2026-10-09 `quit` set are no longer usable:

```
10-09 quit entries: 11
same paneKey present now: 0
same session id present now: 1      (in the entries, in agent-hooks/last-status.json and in ~/.claude/sessions)
same session id AND same paneKey: 0
```

This holds for the `quit` set. Across all 30 old entries, 8 pane keys and 14 session IDs still exist today (mostly old `live`/`done` entries), so "the restart changes the key" is shown for the `quit` set only.

The current store holds 1 `quit` entry and 39 `live` entries, 31 of them captured on 10-12 (32 entries counting the `quit` one). The `quit` entry has `capturedAt` 10-12 16:09:38 (about 2 minutes before the shutdown at 16:11) and `updatedAt` 10-11 14:19, state `waiting`. It is probably from the PC restart (timing only; the user closing that pane is not excluded: the entry has no terminal now). The roster of that restart is otherwise not in the store: no other entry is a pre-restart capture of an agent that was alive at the restart. The 8 older `live` entries in the store (captured 08-24 to 10-06, all stale) are carried over from earlier sessions. Why only one agent got a `quit` mark is unknown. A possible reason is that the other `quit` marks were consumed or converted when the sessions were restored (a hypothesis, not confirmed). All the other entries have new pane keys, as the map says.

**Older copies.**

- `profile-state.db.backup.<epoch-ms>-<uuid>.db` (all 5 files are from after the 10-12 restart; none is from around a crash): taken about every hour (19:04, 20:05, 21:05, 22:05, 23:05 today). Only the 5 newest files exist. Each is a full copy of the database. Today's oldest one has 27 entries. The backups that existed on 10-09 are gone, so a crash found more than about 5 hours later has no backup from before it. (The count 5 and the hourly cycle are what this machine shows. They are not documented.)
- `~/.config/orca/profiles/local-default/orca-data.json`, `orca-data.json.bak.0` to `.bak.4` (all from 09-29, so no use for 10-09) and `orca-data.json.sqlite-export.<pid>.json`: JSON exports of the same state. 5 exist (09-29 13:59, 09-30 14:38 and 14:39, 10-06 11:17, 10-09 14:38:59). None exists for 10-07 or 10-12. They hold `quit` entries at 09-29, 09-30 (x2), 10-06 and 10-09, which points to an orderly Orca exit as the trigger (not confirmed). None was written for 10-07 or 10-12. This is why the 10-09 snapshot survived; it cannot be relied on for the next crash.

### B. Orca: terminal list and `worktree ps` (live)

`orca-ide terminal list --json` row fields: `handle`, `ptyId`, `incarnationId`, `orphaned`, `worktreeId`, `worktreePath`, `branch`, `tabId`, `leafId`, `title`, `connected`, `writable`, `lastOutputAt`, `preview`, `executionHostId`, `agentIdentity`.
`orca-ide worktree ps --json` agent fields: `paneKey`, `parentPaneKey`, `state`, `agentType`, `prompt`, `taskTitle`, `displayName`, `lastAssistantMessage`, `toolName`, `toolInput`, `interrupted`, `mainAgent`, `stateStartedAt`, `updatedAt`.

```
(counts at the time of writing; they drift)
terminals 51, orphaned: {False: 51}, agentIdentity: {'claude': 32, None: 19}
worktrees 67, agents 34: {('claude','working'): 20, ('claude','done'): 12, ('claude','waiting'): 2}
```

They hold the **current** state: worktree path, branch, `paneKey` (`tabId:leafId`), state and time. They hold no Claude session ID and no role. After a crash they show only what Orca restored, so they cannot say what is missing. The `orphaned` flag is `false` for all 51 terminals now; the 21 orphaned terminal records of 10-09 are no longer listed, and no copy of that listing was saved, so **no real record of them survives** to show here. The closest evidence is the 21 strings of `claudeLivePtySessionIds` in the pre-crash file (source A).

### C. Orca: hook cache `agent-hooks/last-status.json`

`~/.config/orca/agent-hooks/last-status.json`, top level `version`, `entries`, `authorityCommitments`. Each entry (keyed by `paneKey`) has `paneKey`, `source`, `tabId`, `worktreeId`, `hookEventName`, `providerSession` (`key`, `id`, `transcriptPath`), `payload` (`state`, `agentType`, `lastAssistantMessage`, `mainAgent`, ...), `receivedAt`, `stateStartedAt`, `launchTokenHash`. It has the session ID and time of the last hook, no role.

Today: 37 entries, `receivedAt` from 10-06 11:20 to now; 31 are from 10-12 and 6 are from 10-06. 34 are in `worktree ps`. The file is rewritten on every hook event (modified at the time of the last event) and holds no entry from the 10-09 crash, so it does not keep the roster across a restart.

### D. Orca: `terminal-history/<id>/meta.json`

260 folders with a `meta.json` (plus 3 without). 158 have `cwd`, `cols`, `rows`, `startedAt`, `endedAt`, `exitCode`; 102 have only `createdAt` and `worktreeId`. Of the 158, `endedAt` is `null` in 153 and set in 5. It is therefore not a reliable end mark (it stays `null` for old terminals too), and the folder name is not a pane key. No agent, no session ID. **Not usable.**

### E. Orca: `orchestration.db`

Tables `runs`, `dispatch_contexts` (`assignee_pane_key`, `assignee_orca_session_id`, `status`, `last_heartbeat_at`, `termination_reason`), `worker_terminal_resources` (`pane_key`, `ownership_state`, `release_state`), and others. It covers **only agents that took part in an orchestration run** (workers and their coordinators), not agents started by hand. `assignee_orca_session_id` is an Orca session ID; it was not compared with the Claude session ID, so it is not shown to be one. The 17 dispatches with `status = 'dispatched'` now are all from 10-12 20:42 or later.

The database also marks open dispatches `failed` after a restart. After the 10-09 event, 14 dispatches got `failed` between `2026-10-09T17:42Z` and `17:58Z` (per minute: 17:42 one, 17:53 one, 17:54 three, 17:55 four, 17:57 four, 17:58 one; the one at 17:53 has `termination_reason = 'unknown'`). Only **6 of the 14 were created before the new daemon started**; the other 8 were created after it and failed at once. Of the 6, 4 match the `quit` entries of source A (all `working`); the other 2 match `done` entries (last update 10-09 02:12 and 02:13), so a `failed` mark covers a dispatch left open, not proof that the agent was alive. After the PC restart, 8 dispatches, all created before it, got `failed` in the minute `2026-10-12T19:13Z`; 5 of them have a heartbeat and 3 have none. After the 10-09 startup, 1 failure came about 3 minutes later (it was created after the startup) and the other 13 came 14 to 19 minutes later. After the 10-12 startup all 8 came in the first minute.

So E is a **partial cross-check** for orchestrated workers (`assignee_pane_key`, worktree through `worker_terminal_resources`): it agrees with A for 4 workers. It is not a usable roster by itself, because open does not mean alive, and it does not cover agents started by hand.

### F. orca-broadcast's own state: `~/.local/state/orca-broadcast/`

`broadcasts/*.json` (3 files, 10-07/10-08 and 10-12) and `pauses/*.json` (1 file, 10-08). A broadcast target and a paused agent hold `paneKey`, `repoId`, `repo`, `worktreeId`, `worktreePath`, `worktree`, `role`, `orchestrationRunIds`, `lastHandle` and per-run state. No session ID. They list only the **targets of one command**, and only for commands that were run. There is no file from around 10-09. Today the tool saves no roster.

### G. Claude Code: `~/.claude/projects/<project>/<session>.jsonl` and `~/.claude/sessions/<pid>.json`

- `projects/*/*.jsonl`: one file per session (614 files at the time of writing). The file name is the session ID; the folder name is the working directory. Only names and modification times were read. The modification time is **not** the last activity before the crash: 7 files share a modification time of 10-09 14:39:44 (the minute of the new daemon start), and only 4 of the 11 `quit` sessions are among them; the other 7 `quit` sessions have later times (10-09 15:46 to 10-12 23:15), probably because the session was resumed or kept running (not confirmed). For a crash, a file cannot say "alive before". Planned shutdowns show a signal: 9 files have a modification time in the minute of the shutdown of 10-12 (16:11) and about 15 in the minute of the shutdown of 10-07 (17:41; 14 at a later recount). Its completeness was not tested.
- `sessions/<pid>.json` (32 files): fields `pid`, `sessionId`, `cwd`, `startedAt`, `procStart`, `version`, `kind`, `entrypoint`, `name`, `status`, `updatedAt`, `statusUpdatedAt`. The directory also holds `<pid>.<hash>.key` files, and the field list is not exhaustive. It is a **registry of live processes**: all 32 pids exist in `/proc` now (a reused pid was not excluded), and no stale file exists (only because all 32 started after the restart). The `startedAt` of all 32 is from 10-12 16:13 or later (after the restart), so no pre-restart file survived. It lists no pane key, no worktree and no role. Whether a crash leaves stale files here was not tested.

## Comparison

| Source | Worktree | Role | Session ID | Last activity | Survives a crash | Staleness |
|---|---|---|---|---|---|---|
| A. `sleepingAgentSessionsByPaneKey` (live store) | via `worktreeId` | no | yes | `updatedAt` (status change) | no: rewritten at restore | `quit` marks written at the 10-09 exit; not ground truth (11 marks vs 21 pty ids, 1 mark possibly dead); the 10-12 shutdown left only 1; weeks old for old `live` entries |
| A. hourly backups of the store | same | no | yes | same | expected for about 5 hours; untested against a crash | up to ~1 hour before the crash |
| A. `orca-data.json` (10-09) | same | no | yes | same | one copy; appears to be written at an Orca exit (unconfirmed) | marks written at that exit; not ground truth (see source A) |
| B. `terminal list` / `worktree ps` | path, branch | no | no | `lastOutputAt`, `updatedAt` | no: shows only what came back | live |
| C. `last-status.json` | `worktreeId` | no | yes | `receivedAt` | no: no 10-09 entries | last hook |
| D. `terminal-history` | `cwd` | no | no | no | not usable | n/a |
| E. `orchestration.db` | via `worktree_id` | orchestration run only | Orca session ID, not compared | `last_heartbeat_at` | yes | only orchestrated workers |
| A'. `claudeLivePtySessionIds` | in the string | no | no | no | pre-crash copy only | 21 strings in `orca-data.json` |
| F. orca-broadcast state | yes | yes | no | no | yes | only targets of a command that ran |
| G. Claude `projects/*.jsonl` | `cwd` | no | name of file | mtime (unreliable for a crash; a signal at a planned shutdown, not tested) | yes | cannot say alive |
| G. Claude `sessions/<pid>.json` | `cwd` | no | yes | `updatedAt` | not tested | live processes only |

## Recommendation

**A roster that orca-broadcast saves itself**, filled from source A (and the live listing B for the worktree and the current `paneKey`), with this design:

- **What to save, per agent:** `paneKey`, `worktreeId` and `worktreePath`, the Claude session ID (`providerSession.id`), `state`, `updatedAt`, the `role` the tool already derives (source F), and the time of the save. Do not copy `prompt`, `lastAssistantMessage` or `agentEnv`.
- **When to save:** at the start and the end of every command that already reads the fleet (`broadcast`, `pause`, `resume`, the group commands). The tool runs only on demand, so the roster is as old as the last command. A command that never runs again leaves a stale roster; a periodic save (for example a timer) is a feature the user must decide.
- **Where:** next to the other state, `~/.local/state/orca-broadcast/`.
- **At recovery:** match each saved agent to the restored session by **session ID**, not by `paneKey` (the restart changes the key), **if** #121 and #123 confirm that a restored session keeps its ID. This note does not show that: only 1 of the 11 `quit` session IDs is present after the restart (7 of the 11 have Claude files written after the crash, so they may have been resumed; not confirmed). Agents whose session ID is missing among the live agents are the missing ones.
- **Second source (no extra work for the tool):** the hourly backups of source A (and its `quit` entries, if the restored Orca has not yet replaced them), for a crash found within about 5 hours. Use them to add agents that the saved roster missed (started after the last command) and to check the saved roster. In a backup the unfinished agents are `live`/`working`, not `quit`, so select by `state` and `updatedAt`. No backup from before a crash exists today, so this use is untested. Their format is undocumented and may change with an Orca update, so treat them as a hint, not as the contract.

**What the recommendation misses.**

- An agent started and lost between two tool commands, if the backups are also too old.
- The role of an agent that the tool never saw (A has no role).
- A planned restart where the user closes agents first: a `done` agent is not "alive before" and the roster must not restart it. The `state` field helps, but "alive" is a decision for the spec.
- Non-Claude agents (out of scope).

**Reject.** Claude Code's session files (G, `projects`): they are unreliable for a crash. `terminal-history` (D): no agent data. The live `terminal list` and `worktree ps` (B): they only show what survived.

## Not tested

- A crash or restart on purpose (the safety rules forbid it). Everything about the state after an event comes from the two real events above.
- Whether Orca writes `quit` marks and exports after a hard kill or a power loss: not shown. They appear at orderly exits (source A). Why none was written on 10-07 and only one `quit` mark on 10-12 is unknown.
- What a backup holds around a crash (no such backup exists).
- Whether a restored session keeps its Claude session ID (questions #121 and #123).
- Why Orca started at 14:39:28 on 10-09: `~/.cache/orca/appimage/` was unpacked at 14:39:30, so Orca was launched again then; this does not show how the earlier process ended.
- Whether `~/.claude/sessions/<pid>.json` stays after a crash.
- What trigger writes the `sqlite-export` files and rotates the hourly backups.
- Fixtures: no fixture was added. A redacted copy of one `sleepingAgentSessionsByPaneKey` document and one `worktree ps` agent list can be made from the structure above when the spec needs one.
