# Which identity links a restored session to its old agent?

("Restored" here means the agent runs again after a restart. Only agents started with `claude --resume` could be traced, so the evidence speaks about "resumed" agents.)

Research for issue #121 (map #120). Captured 2026-10-12 on Linux. Claude Code v2.1.296. Orca CLI: `orca-ide`.
No `src/` or test change. Read only: listings and files on disk. No terminal was created, read, written or waited on. The built CLI was not run.

## Answer in short

1. **The Claude Code session ID is the best link, but the evidence is narrow.** A session restarted with `claude --resume <id>` keeps its ID. In 8 of 8 live processes started this way, the `--resume` argument equals the session ID. In 7 of those 8, the transcript file also has a first record older than the boot (the 8th is not explained). Nothing here shows how often Orca's restore uses `--resume`: 21 of 30 live sessions have no `--resume` in the command line. A session that got a new ID can never show up in a match on session ID, so the data cannot count those cases. This is a selection bias.
2. **`paneKey` changed for every resumed agent that can be checked.** 14 session IDs appear in both the 10-09 snapshot and today. Of these, 5 have a live `--resume` process, and all 5 have a new `paneKey` (new tab ID and new leaf ID). The other 9 are stale records without a live process (8 unchanged, 1 with a key that differs from the snapshot). The snapshot is the last Orca-written copy found before the restart (10-09 14:39); it may have been written at an Orca start rather than at crash time. The note cannot tie it to a crash: the map reports an Orca crash on 2026-10-09, but no file here shows its time. So the change spans every Orca or PC restart between 10-09 14:39 and now, and a manual `claude --resume` in a new pane would give the same result; the data cannot separate these causes. One stale record has a key that differs from the snapshot; its current record was captured 146 s before boot, so the key change happened at or before that time and its cause is not determined.
3. **None of the five `orca-ide` JSON listings that were checked has a field for the session ID** (key paths checked on the first 3 list items of each list; item field lists from the first item). They are `terminal list`, `worktree ps`, `worktree list`, `orchestration worker-list` and `orchestration run-list` (E1). The ID can appear by chance inside free text (`terminal list` `preview`, `worktree ps` `preview` and `agents[].toolInput`), which is screen or tool text and not a usable source. The ID exists as a field in files on disk: Orca's `profile-state.db`, Claude's `~/.claude/sessions/<pid>.json` and, as the file name, `~/.claude/projects/*/<id>.jsonl`. `terminal show`, `terminal read` and `search` were not run.
4. **Recommended:** link on the session ID, read from Orca's saved map `sleepingAgentSessionsByPaneKey` (old `paneKey` → session ID) and from `~/.claude/sessions/<pid>.json` plus `/proc/<pid>/environ` (`ORCA_PANE_KEY` → session ID). Use `worktreeId` only as a cross-check. See [Recommendation](#recommendation).

## Method

- Every figure below, except the boot time and the daemon file listing in "Not tested", comes from one read-only script (embedded under Script), [`evidence.py`](#script), run on 2026-10-12 at about 23:44 (local time; the last Orca write times in its output are a lower bound for the run time). It prints counts, field names, enumerated values (states, origins, versions, `ORCA_*` variable names) and dates only. It prints no message text and no variable values. The raw output is quoted in the Evidence section. Every count in the text comes from that one quoted run. Counts of live things (terminals, sessions, map entries) drift by a few within minutes, so a new run gives slightly different numbers there; the counts that depend on the 10-09 snapshot and on transcript files (E4, E5, E6) hardly change; the ages in E6 grow with the time since the run.
- **Pre-restart data is limited.** Claude's `~/.claude/sessions/*.json` files are keyed by process ID and all describe processes started after the 16:12 boot. Orca's hourly `profile-state.db.backup.*` files all date from 19:04 or later. The last Orca-written copy of Orca's session map as a separate file before the restart is `orca-data.json` (file modification time 2026-10-09 14:39:00; its twin `orca-data.json.sqlite-export.48781.json` is 14:38:59). Older copies (09-29 to 10-06) exist but are less useful. So "before" below means "last Orca-written copy, 10-09 14:39", and "now" means "after the 10-12 PC restart". The map reports an Orca crash on 10-09, but no file here shows when it happened or how it relates to 14:39. The comparison covers all restarts in between and cannot separate them.
- Boot time: `uptime -s` gave `2026-10-12 16:12:05` (command output not saved); the script hardcodes this value and echoes it in the `boot` line; on another machine, re-read it with `uptime -s`. Claude Code version: the `version` field of `~/.claude/sessions/<pid>.json` (all 30 are `2.1.296`; E3/E4 line).
- `orca-ide terminal show`, `terminal read` and `orca-ide search` were not run, because they return screen or conversation text. `terminal list` and `worktree ps` also return a short `preview` text; the script only checks whether it contains a session ID and prints no text.

## Candidates

| Candidate | Where it is read | Survives a restart? | Unique per agent? |
|---|---|---|---|
| Claude session ID | `profile-state.db` → `workspaceSession.sleepingAgentSessionsByPaneKey[<paneKey>].providerSession.id`; `…unifiedTabs[][].aiVaultTitle.sessionId`; `~/.claude/sessions/<pid>.json` `sessionId`; transcript file `~/.claude/projects/<dir>/<id>.jsonl`. **No field in the five `orca-ide` JSON listings checked (E1); only incidental text.** | **Yes** with `claude --resume <id>` (5 snapshot IDs reappear unchanged under `--resume`; no live capture across a restart exists): in 8 of 8 processes the `--resume` argument equals the session ID; 7 of 8 continue a transcript older than boot (E4). Not shown: how often a restore uses `--resume` (21 of 30 live sessions have no `--resume` in the command line). A fresh start gives a new ID. | Yes: 38 entries (37 Claude, 1 grok), 38 distinct IDs; 30 live Claude sessions, 30 distinct IDs (E3). |
| `paneKey` (`tabId:leafId`) | `orca-ide terminal list --json` (`tabId`, `leafId`); `worktree ps --json` `agents[].paneKey`; process env `ORCA_PANE_KEY` | **No** for resumed live agents: 5 of 5 changed (tab ID and leaf ID). Across all restarts between 10-09 14:39 and now, not only the PC restart (E5). The 8 unchanged keys in the 14 belong to 8 of the 9 stale records (E5). | Yes at one moment: 32 distinct `paneKey` among 32 `worktree ps` agents; 49 distinct `tabId:leafId` of 49 terminals (E1). |
| Terminal handle | `terminal list --json` `handle` | **Undeterminable.** The 10-09 snapshot holds no handle field (E5). AGENTS.md already says handles go stale and forbids keying on them. | Yes at one moment: 49 distinct of 49 terminals (E1). |
| `worktreeId` (its second part is the worktree path; `worktreePath` was not compared separately) | `terminal list --json` `worktreeId`, `worktreePath` | Yes for the 5 resumed live agents (5 of 5 same); also 9 of 9 stale records (E5). | **No.** 30 Claude terminals sit in 29 worktrees, so one worktree can hold two agents. |
| Terminal title | `terminal list --json` `title` | Weak: 3 of 5 same for the 5 resumed live agents (8 of 9 for stale records). 29 of 30 Claude titles start with a non-ASCII glyph (E1); that the glyph changes with agent state is a guess, not shown here. | 30 of 30 distinct today, but its origin is not shown here (`nameSource` is `derived` in all 30 `~/.claude/sessions` files, E3, but nothing links that name to the terminal `title`). |
| Orca persisted map `sleepingAgentSessionsByPaneKey` | `profile-state.db` (domain `workspaceSession`) | Records persist across restarts (the 10-09 snapshot, E5, and the stale records, E6, are such records). They are not always correct or removed (E6). It is the on-disk store that holds the session ID per `paneKey`, with `worktreeId`, `tabId`, `terminalTitle`, `state`, `origin`. | One entry per `paneKey`; 38 entries (37 Claude, 1 grok) have 38 distinct session IDs (E2). |
| Process env `ORCA_PANE_KEY` / `ORCA_TAB_ID` / `ORCA_WORKTREE_ID` / `ORCA_TERMINAL_HANDLE` | `/proc/<pid>/environ` of the `claude` process, joined to `~/.claude/sessions/<pid>.json` | Live only. Gives the new `paneKey` of a resumed session. Field names confirmed in E3 (`ORCA_*` names line). | 30 live sessions have 30 distinct session IDs and `ORCA_PANE_KEY` matched the map for 29 of 30 processes (E3). |
| Claude `pid`, `startedAt` | `~/.claude/sessions/<pid>.json` | No. New process after a restart. | Yes while alive. |
| `incarnationId` / `ptyId` | `terminal list --json` | **Undeterminable.** The 10-09 snapshot holds none of these fields (E5). `ptyId` contains `@@` (49 of 49, E1) (PTY = pseudo-terminal; whether it belongs to the terminal or to the agent is not shown). | Unique today: 49 distinct `ptyId` and 49 distinct `incarnationId` of 49 terminals (E1). |

## Evidence

Command and raw output of [`evidence.py`](#script), redacted by construction (counts and field names only). Read-only reads used: `orca-ide terminal list --include-visual-layouts` and plain `orca-ide terminal list` (both with `--json`, appended by the script), `orca-ide worktree ps --json`, `orca-ide worktree list --json`, `orca-ide orchestration worker-list --json`, `orca-ide orchestration run-list --json`, `profile-state.db` opened with `mode=ro`, and `/proc/<pid>/cmdline` and `/proc/<pid>/environ` of each live `claude` process (only the `-r`/`--resume` argument and `ORCA_*` values were used, never printed).

```sh
python3 -I evidence.py
```

```text
== E0 dates ==
profile-state.db.backup.17918<uuid>178851b9b.db 2026-10-12T19:04:25
profile-state.db.backup.17918<uuid>b3ee5d423.db 2026-10-12T20:05:29
profile-state.db.backup.17918<uuid>7cb21080b.db 2026-10-12T21:05:31
profile-state.db.backup.17918<uuid>009071ac1.db 2026-10-12T22:05:47
profile-state.db.backup.17918<uuid>c4793b4ab.db 2026-10-12T23:05:55
orca-data.json 2026-10-09T14:39:00
orca-data.json.bak.0 2026-09-29T13:59:40
orca-data.json.bak.1 2026-09-29T07:17:10
orca-data.json.bak.2 2026-09-29T06:16:44
orca-data.json.bak.3 2026-09-29T05:16:07
orca-data.json.bak.4 2026-09-29T04:15:44
orca-data.json.sqlite-export.1.json 2026-09-29T13:59:53
orca-data.json.sqlite-export.23389.json 2026-10-06T11:17:35
orca-data.json.sqlite-export.4016.json 2026-09-30T14:38:25
orca-data.json.sqlite-export.4020.json 2026-09-30T14:39:43
orca-data.json.sqlite-export.48781.json 2026-10-09T14:38:59
boot 2026-10-12T16:12:05

== E1 orca-ide JSON: any field named like session ==
terminal list: 43 key paths (first 3 list items sampled); names containing "session": []
   string values (all list items) containing a live session ID, by field: {'.terminals[].preview': 8}
worktree ps: 60 key paths (first 3 list items sampled); names containing "session": []
   string values (all list items) containing a live session ID, by field: {'.worktrees[].agents[].toolInput': 5, '.worktrees[].preview': 7}
worktree list: 68 key paths (first 3 list items sampled); names containing "session": []
   string values (all list items) containing a live session ID, by field: {}
orchestration worker-list: 79 key paths (first 3 list items sampled); names containing "session": []
   string values (all list items) containing a live session ID, by field: {}
orchestration run-list: 9 key paths (first 3 list items sampled); names containing "session": []
   string values (all list items) containing a live session ID, by field: {}
terminal list item fields: ['agentIdentity', 'branch', 'connected', 'executionHostId', 'handle', 'incarnationId', 'lastOutputAt', 'leafId', 'orphaned', 'preview', 'ptyId', 'tabId', 'title', 'worktreeId', 'worktreePath', 'writable']
worktree ps agents[] fields: ['agentType', 'displayName', 'interrupted', 'lastAssistantMessage', 'mainAgent', 'paneKey', 'parentPaneKey', 'prompt', 'state', 'stateStartedAt', 'taskTitle', 'toolInput', 'toolName', 'updatedAt'] | agents: 32 | distinct paneKey: 32
uniqueness among 49 terminals: distinct handle 49 | ptyId 49 | incarnationId 49 | tabId:leafId 49
agentIdentity values {'claude': 30, None: 19} | titles of claude terminals starting with a non-ASCII glyph: 29 | ptyId contains @@: 49 of 49
terminals 49 orphaned 0 claude 30 distinct worktreeId among claude 29 distinct titles among claude 30

== E2 profile-state.db ==
automationRuns 4 2026-09-29T13:59:53
automations 2 2026-09-29T13:59:53
claudeLivePtySessionIds 3884 2026-10-12T23:41:34
codexResetCreditAttemptLedger 27 2026-09-29T13:59:53
deletedSshConfigAliases 2 2026-09-29T13:59:53
featureInteractionTelemetryBuckets 530 2026-10-10T01:10:06
folderWorkspaces 2 2026-09-29T13:59:53
legacyPaneKeyAliasEntries 2 2026-09-29T13:59:53
migrationUnsupportedPtyEntries 2 2026-09-29T13:59:53
mobileClientTabSelectionsByDeviceId 1345 2026-09-29T13:59:53
onboarding 347 2026-09-29T13:59:53
projectGroups 487 2026-09-29T13:59:53
projectHostSetups 10375 2026-10-12T17:44:11
projects 14047 2026-10-12T17:44:11
repos 16784 2026-10-12T17:44:11
retiredWorktreeNamesByNamespace 115 2026-09-29T13:59:53
retiredWorktreeNamesByRepo 79 2026-09-29T13:59:53
schemaVersion 1 2026-09-29T13:59:53
settings 9264 2026-10-11T15:42:52
sparsePresetsByRepo 2 2026-09-29T13:59:53
sshPtyConsumerRecoveries 2 2026-09-29T13:59:53
sshRemotePtyLeases 2 2026-09-29T13:59:53
sshTargetGenerationCounter 1 2026-09-29T13:59:53
sshTargets 380 2026-09-29T13:59:53
ui 10297 2026-10-12T23:44:07
workspaceLineageByChildKey 20656 2026-10-12T23:17:15
workspaceSession 309664 2026-10-12T23:43:58
workspaceSessionsByHostId 2 2026-09-29T13:59:53
worktreeIdentityAliases 18997 2026-10-12T23:17:15
worktreeLineageById 19856 2026-10-12T23:17:15
worktreeMeta 79954 2026-10-12T23:43:00
worktreeMetaByIdentity 2 2026-09-29T13:59:53
sleeping entries 38 distinct ids 38 Counter({'claude': 37, 'grok': 1}) Counter({'live': 37, 'quit': 1})
entry fields: ['agent', 'capturedAt', 'connectionId', 'origin', 'paneKey', 'prompt', 'providerSession', 'state', 'tabId', 'terminalTitle', 'updatedAt', 'worktreeId'] | providerSession keys: ['id', 'key']
providerSession.key values: {'session_id': 38}
claudeLivePtySessionIds: list 31 | items containing @@ (ptyId form): 31
legacyPaneKeyAliasEntries list 0
worktreeIdentityAliases dict 111
aiVaultTitle keys: ['agent', 'sessionId', 'title']
tabs with aiVaultTitle.sessionId 38

== E3/E4 live sessions ==
sessions/<pid>.json keys: ['cwd', 'entrypoint', 'kind', 'messagingSocketPath', 'name', 'nameSince', 'nameSource', 'peerFeatures', 'peerProtocol', 'pid', 'pidDomain', 'procStart', 'sessionId', 'startedAt', 'status', 'statusUpdatedAt', 'updatedAt', 'version']
nameSource values {'derived': 30}
1 ('bare_-r', 'sleeping_has_id', False, 'sleeping_key==ORCA_PANE_KEY', None, 'aiVault_has_id', False, 'tab==ORCA_TAB_ID', None)
21 ('no_-r', 'sleeping_has_id', True, 'sleeping_key==ORCA_PANE_KEY', True, 'aiVault_has_id', True, 'tab==ORCA_TAB_ID', True)
8 ('resumed_with_id', 'sleeping_has_id', True, 'sleeping_key==ORCA_PANE_KEY', True, 'aiVault_has_id', True, 'tab==ORCA_TAB_ID', True)
ORCA_* env names seen: ['ORCA_AGENT_HOOK_ENDPOINT', 'ORCA_AGENT_HOOK_ENV', 'ORCA_AGENT_HOOK_OPENCODE_TUI', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN', 'ORCA_AGENT_HOOK_TRANSPORT', 'ORCA_AGENT_HOOK_VERSION', 'ORCA_AGENT_LAUNCH', 'ORCA_AGENT_LAUNCH_TOKEN', 'ORCA_AGENT_PANE', 'ORCA_APP_VERSION', 'ORCA_CLI_BIN_DIR', 'ORCA_HISTFILE', 'ORCA_IMAGE_PROTOCOL', 'ORCA_OPENCODE_AGENT', 'ORCA_PANE_KEY', 'ORCA_TAB_ID', 'ORCA_TERMINAL_HANDLE', 'ORCA_USER_DATA_PATH', 'ORCA_WORKSPACE_ID', 'ORCA_WORKTREE_ID']
live sessions 30 distinct sessionIds 30 | versions {'2.1.296': 30} | earliest startedAt - boot (s): 75 | all after boot: True
resumed with id (id == sessionId): 8 | transcript first record before boot: 7
transcripts 615 changed after boot 66 file name is the only sessionId (first 400 lines) 66

== E5 10-09 snapshot vs now ==
snapshot size: 30 | shared ids: 14 | snapshot ids absent now: 16
live resumed with id, id in 10-09 snapshot: 5
shared & live --resume process: n=5 paneKey_changed=5 (tab and leaf both differ: 5) worktree_same=5 title_same=3
shared & live process, not --resume: n=0 paneKey_changed=0 (tab and leaf both differ: 0) worktree_same=0 title_same=0
shared & no live process (stale): n=9 paneKey_changed=1 (tab and leaf both differ: 1) worktree_same=9 title_same=8
capturedAt of stale records that changed paneKey, minus boot (s): [-146]
snapshot entry fields (count of 30 entries): {'paneKey': 30, 'tabId': 30, 'worktreeId': 30, 'agent': 30, 'providerSession': 30, 'prompt': 30, 'state': 30, 'capturedAt': 30, 'updatedAt': 30, 'terminalTitle': 30, 'connectionId': 30, 'origin': 30, 'launchConfig': 14, 'lastAssistantMessage': 7}
handle/incarnation/ptyId fields in any snapshot entry: []
snapshot entries with launchConfig: 14 | launchConfig keys: ['agentArgs', 'agentCommand', 'agentEnv']

== E6 entries with no live claude process ==
n 9 captured before boot 9 tab in tabsByWorktree 9 tombstone 0 transcript on disk 8 agents {'grok': 1, 'claude': 8} states {'done': 7, 'waiting': 2} origin {'live': 8, 'quit': 1}
age hours [7.6, 151.3, 154.9, 156.3, 156.3, 320.7, 320.9, 605.3, 1181.8]
stale ids in the 14 shared 9
```

Reading it:

- **E1 (no session field; uniqueness; field names).** The `terminal list` item fields and the `worktree ps` `agents[]` fields are printed in the output, so the field names used in the Candidates table are shown. Uniqueness today: handle, `ptyId`, `incarnationId` and `tabId:leafId` are each distinct across the 49 terminals; the 32 `agents[].paneKey` values are distinct. The key paths of the five listings (first 3 list items sampled) contain no name with "session". A scan of all string values finds a live session ID only in `terminal list` `preview` (8), `worktree ps` `preview` (7) and `agents[].toolInput` (5): incidental text, not a field. These hit counts change with live screen text. `agentIdentity` is `claude` for 30 terminals and null for 19; it is not a session. `terminal list` shows 49 terminals, none `orphaned`, 30 of them Claude agents, in 29 distinct worktrees, with 30 distinct titles.
- **E0 (dates).** The 5 `profile-state.db.backup.*` files date from 19:04 to 23:05 on 10-12, all after boot. `orca-data.json` is 10-09 14:39:00; older copies date from 09-29 to 10-06.
- **E2 (Orca saved map).** `profile-state.db` table `profile_state_documents` has one row per domain. Domain `workspaceSession` holds `sleepingAgentSessionsByPaneKey`: 38 entries, 38 distinct session IDs. Each entry has `paneKey`, `tabId`, `worktreeId`, `agent`, `providerSession` (keys `id` and `key`; `key` is `session_id` in all 38), `state`, `origin`, `terminalTitle`, `connectionId`, `prompt`, `capturedAt`, `updatedAt`. `unifiedTabs[][].aiVaultTitle` holds the keys `agent`, `sessionId`, `title` for 38 tabs. Domain `claudeLivePtySessionIds` is a list of 31 strings of the `ptyId` form (all contain `@@`), not session IDs. Domains `legacyPaneKeyAliasEntries` (empty list) and `worktreeIdentityAliases` (111 keys, content not inspected) may relate to old and new pane keys.
- **E3 (join of live processes).** For each `claude` process the script joins `~/.claude/sessions/<pid>.json` (`sessionId`), the command line (`-r`/`--resume <id>`) and `ORCA_PANE_KEY`/`ORCA_TAB_ID` with the Orca map. 29 of 30 processes match the Orca map on session ID, `paneKey` and tab ID. One process was started with a bare `-r`/`--resume` and has no entry in the map. Cause not found.
- **E4 (resume keeps the ID).** 8 processes have `--resume <id>` with `<id>` equal to their `sessionId`. 7 of them have a transcript whose first record is older than boot, so a transcript older than boot exists for them. For the 8th, the data does not say why. All 66 transcripts changed after boot have their own file name as the only `sessionId` (first 400 lines). Only 5 of the 8 resumed IDs are in the 10-09 snapshot.
- **E5 (snapshot vs now).** Only the "shared & live --resume process" row (5 agents; the row for live processes without `--resume` is empty) describes resumed agents: `paneKey` changed 5 of 5 (tab and leaf both), `worktreeId` stayed 5 of 5, title stayed 3 of 5. The "stale" row (9) holds records without a live process, so their unchanged keys say nothing about restore. One of the 9 has a key that differs from the snapshot; its current record was captured 146 s before boot, so the key change happened at or before that time and its cause is not determined. No snapshot entry (any of 30) has a handle, `incarnationId` or `ptyId`. 14 of the 30 have a `launchConfig` (keys `agentArgs`, `agentCommand`, `agentEnv`; values not printed). It may show how Orca launched the agent, so it bears on how often a restore uses `--resume`; it was not inspected further.
- **E6 (agents that did not come back).** 9 entries of the map have no live `claude` process (8 Claude entries and the 1 grok entry; the script prints this split). All 9 were captured before boot, all 9 tabs are still in `workspaceSession.tabsByWorktree`, none has a closed-tab marker (a "tombstone": Orca's record that the user closed that tab), 8 have a transcript on disk. They are exactly the 9 stale entries of E5. Ages go up to 1181 h (about 7 weeks), so stale entries are not always cleaned up. Separately, 16 snapshot entries are absent now (E5). The 9 stale entries may be agents the user abandoned.

## Recommendation

**Use the Claude session ID as the identity of an agent. Treat `paneKey` as only the current address of that session.** Confidence: fairly high on this machine that `--resume` keeps the ID (observed on one machine, Claude Code 2.1.296, 8 processes; 7 of 8 have a transcript older than boot and 5 of 8 are in the 10-09 snapshot); medium that `paneKey` changes on resume (5 of 5 resumed agents, confounded by the other restarts since 10-09 14:39 and by manual resume); low on how often a restore uses `--resume`.

Flow for a recovery feature:

1. **Before a restart (every `pause` or `broadcast` run):** store `sessionId` next to each `paneKey` in the run's state file. Source: for every live `claude` process, `~/.claude/sessions/<pid>.json` → `sessionId`, joined by `/proc/<pid>/environ` → `ORCA_PANE_KEY`. This makes the run file independent of Orca's own map.
2. **After a restart:** build the same table again. Match old and new rows on `sessionId`. The new row gives the new `paneKey`.
3. **No match on session ID:** the agent did not come back, or came back under a new ID. Its last-known `worktreeId` (from the stored row) tells where to restart it with `claude --resume <sessionId>` after confirmation.
4. **Without a stored run (crash, no open run):** fall back to Orca's `sleepingAgentSessionsByPaneKey` (old `paneKey` → `sessionId`, `worktreeId`, `state`). This is a best-effort roster (E6) and includes agents the user may have abandoned.

Use `worktreeId` only as a cross-check (it stayed the same for 5 of 5 resumed agents), never as the key (not unique: 30 agents in 29 worktrees). Do not use the title (it changed for 2 of 5 resumed agents). Do not use the handle or `pid`.

### Failure cases

| Case | Effect | Evidence |
|---|---|---|
| Agent started fresh after restart (no `--resume`) | New session ID; old ID never matches. The agent looks "missing" although a replacement runs in the same worktree. | 21 of 30 live sessions have no `--resume` (not proven to be fresh starts; Orca may restore some another way). |
| Process has no entry in Orca's map | `sleepingAgentSessionsByPaneKey` has no entry for the process, so only the `~/.claude/sessions` + `/proc` join works. | 1 process started with a bare `-r`/`--resume` (no id in the command line) had no sleeping entry and no `aiVault` id. Cause not found. |
| `~/.claude/sessions/<pid>.json` describes only post-boot processes | After a restart these files hold no pre-restart data, so they cannot be the only "before" source. | The `startedAt` of all 30 files is after boot (E3/E4 line: earliest is 75 s after boot). |
| Orca map is stale or over-complete | Some old entries stay for weeks (up to about 7 weeks, E6). 16 snapshot entries are absent now (E5); the data cannot say whether Orca dropped them or the user closed them. Using it alone would list abandoned agents. | E6. |
| Reading `/proc/<pid>/environ` | Linux only, same user only. It is not an `orca-ide` API. It holds the whole environment, so a tool must read only `ORCA_PANE_KEY` (and `ORCA_TAB_ID`) and store nothing else (the `ORCA_*` set also has token variables). | `ORCA_PANE_KEY` equals the map's `paneKey` for 29 of 30 live processes (E3). Not tested on other systems or users. |
| Non-Claude agent (`grok` entry exists) | Out of scope (`.out-of-scope/non-claude-agents.md`). | E2. |
| Session ID changes while the agent lives (for example `/clear` or compaction) | A match on session ID would fail. Not tested; E4 shows only that 66 transcripts each carry their own ID. | Untested. |
| Two live processes with one session ID | Not observed (30 live sessions, 30 distinct session IDs; the saved map has 38 entries, 38 IDs). Not tested what happens if the user resumes the same ID in two panes. | Untested. |

## Fixtures

None captured. No `orca-ide` listing carries the session ID, so a fixture of a restart would also have to include the shape of `sleepingAgentSessionsByPaneKey` (E2) and of `~/.claude/sessions/<pid>.json` (E3).

## Not tested

- No live pre-restart capture of the 2026-10-12 PC restart exists (no backup before 19:04). A reproducible capture needs a future run of the "before" step of the recommendation.
- `paneKey` stability across a clean Orca-only restart, or across the PC restart alone.
- How often Orca's restore starts a session with `--resume`, and why one process started with a bare `-r`/`--resume` has no entry in Orca's map.
- Whether handles, `ptyId` or `incarnationId` change across a restart (the 10-09 snapshot holds none of them).
- Other `orca-ide` commands that might print a session ID: `terminal show`, `terminal read` and `search` return screen or conversation text and were not run; `worktree show`, `worktree current` and the other `orchestration` commands were not run.
- What `worktreeIdentityAliases` holds (111 keys), and the values of `launchConfig.agentArgs` in the 10-09 snapshot (14 entries): they may show whether Orca restores with `--resume`.
- Other `ORCA_*` variables (`ORCA_WORKSPACE_ID`, tokens) and the item fields of `orchestration worker-list` / `run-list` as possible identities.
- Survival of `worktreePath` alone (only `worktreeId` was compared).
- A change of session ID inside a live agent (`/clear`, compaction).
- Fields that appear only on later list items of the `orca-ide` listings (key names were sampled on the first 3 items).
- Starting a Claude Code session in a throwaway terminal was not done (blocked by the map's safety rule).
- How the Orca daemon (`~/.config/orca/daemon/daemon-v41.*`) keeps PTYs alive across an Orca crash. Only its file names were listed.

## Sources

- Orca state: `~/.config/orca/profiles/local-default/profile-state.db` and `~/.config/orca/profiles/local-default/orca-data.json` (read only).
- Claude Code state: `~/.claude/sessions/<pid>.json`, `~/.claude/projects/*/<id>.jsonl` (file names, field names and timestamps only), `/proc/<pid>/cmdline` and `/proc/<pid>/environ`.
- Orca CLI: `orca-ide terminal list`, `worktree ps`, `worktree list`, `orchestration worker-list`, `orchestration run-list` (all `--json`).
- Related: #122 and #123 (other questions of map #120); `AGENTS.md` (paneKey rule).

## Script

`evidence.py` is not a file in the repo: copy the block below out of this note to run it with `python3 -I evidence.py`. It is read only.

```python
import json, glob, os, re, sqlite3, subprocess, collections, datetime
HOME = os.path.expanduser('~')
PROFILE = f'{HOME}/.config/orca/profiles/local-default'
BOOT = int(subprocess.check_output(['date', '-d', '2026-10-12 16:12:05', '+%s']))
def ide(*a): return json.loads(subprocess.check_output(['orca-ide', *a, '--json']))['result']
SIDS = {json.load(open(f))['sessionId'] for f in glob.glob(f'{HOME}/.claude/sessions/*.json')}
def value_hits(o, p='', acc=None):
    acc = collections.Counter() if acc is None else acc
    if isinstance(o, dict):
        for k, v in o.items(): value_hits(v, p + '.' + k, acc)
    elif isinstance(o, list):
        for v in o: value_hits(v, p + '[]', acc)
    elif isinstance(o, str) and any(sid in o for sid in SIDS): acc[p] += 1
    return acc
def keypaths(o, p=''):
    out = set()
    if isinstance(o, dict):
        for k, v in o.items():
            out.add(p + ('<id>' if re.match(r'^[0-9a-f-]{36}', k) else k)); out |= keypaths(v, p + ('<id>' if re.match(r'^[0-9a-f-]{36}', k) else k) + '.')
    elif isinstance(o, list):
        for v in o[:3]: out |= keypaths(v, p + '[].')
    return out

print('== E0 dates ==')
for pat in ('profile-state.db.backup.*', 'orca-data.json*'):
    for f in sorted(glob.glob(f'{PROFILE}/{pat}')):
        print(re.sub(r'[0-9a-f]{8}-[0-9a-f-]{27}', '<uuid>', os.path.basename(f)), datetime.datetime.fromtimestamp(os.path.getmtime(f)).isoformat(timespec='seconds'))
print('boot', datetime.datetime.fromtimestamp(BOOT).isoformat(timespec='seconds'))
print('\n== E1 orca-ide JSON: any field named like session ==')
for name, args in (('terminal list', ['terminal', 'list', '--include-visual-layouts']), ('worktree ps', ['worktree', 'ps']),
                   ('worktree list', ['worktree', 'list']), ('orchestration worker-list', ['orchestration', 'worker-list']),
                   ('orchestration run-list', ['orchestration', 'run-list'])):
    try: d = ide(*args)
    except Exception as e: print(name, 'ERR', type(e).__name__); continue
    ks = keypaths(d)
    print(f'{name}: {len(ks)} key paths (first 3 list items sampled); names containing "session": {sorted(k for k in ks if "session" in k.lower())}')
    print(f'   string values (all list items) containing a live session ID, by field: {dict(value_hits(d))}')
tl = ide('terminal', 'list')['terminals']
print('terminal list item fields:', sorted(tl[0].keys()))
wps = ide('worktree', 'ps')['worktrees']
ag = [a for w in wps for a in w.get('agents', [])]
print('worktree ps agents[] fields:', sorted(ag[0].keys()), '| agents:', len(ag), '| distinct paneKey:', len({a['paneKey'] for a in ag}))
print('uniqueness among', len(tl), 'terminals: distinct handle', len({t['handle'] for t in tl}), '| ptyId', len({t['ptyId'] for t in tl}), '| incarnationId', len({t['incarnationId'] for t in tl}), '| tabId:leafId', len({t['tabId'] + ':' + t['leafId'] for t in tl}))
print('agentIdentity values', dict(collections.Counter(t.get('agentIdentity') for t in tl)), '| titles of claude terminals starting with a non-ASCII glyph:', sum(1 for t in tl if t.get('agentIdentity') == 'claude' and ord(t['title'][:1] or 'a') > 127), '| ptyId contains @@:', sum('@@' in t['ptyId'] for t in tl), 'of', len(tl))
print('terminals', len(tl), 'orphaned', sum(t['orphaned'] for t in tl), 'claude', sum(t.get('agentIdentity') == 'claude' for t in tl),
      'distinct worktreeId among claude', len({t['worktreeId'] for t in tl if t.get('agentIdentity') == 'claude'}),
      'distinct titles among claude', len({t['title'] for t in tl if t.get('agentIdentity') == 'claude'}))

db = sqlite3.connect(f'file:{PROFILE}/profile-state.db?mode=ro', uri=True)
print('\n== E2 profile-state.db ==')
for d, n, u in db.execute('SELECT domain, length(payload), updated_at FROM profile_state_documents ORDER BY domain'):
    print(d, n, datetime.datetime.fromtimestamp(u / 1000).isoformat(timespec='seconds'))
ws = json.loads(db.execute("SELECT payload FROM profile_state_documents WHERE domain='workspaceSession'").fetchone()[0])
now = ws['sleepingAgentSessionsByPaneKey']
print('sleeping entries', len(now), 'distinct ids', len({v['providerSession']['id'] for v in now.values()}),
      collections.Counter(v['agent'] for v in now.values()), collections.Counter(v['origin'] for v in now.values()))
print('entry fields:', sorted(next(iter(now.values())).keys()), '| providerSession keys:', sorted(next(iter(now.values()))['providerSession'].keys()))
cl = json.loads(db.execute("SELECT payload FROM profile_state_documents WHERE domain='claudeLivePtySessionIds'").fetchone()[0])
print('providerSession.key values:', dict(collections.Counter(v['providerSession']['key'] for v in now.values())))
print('claudeLivePtySessionIds:', type(cl).__name__, len(cl), '| items containing @@ (ptyId form):', sum('@@' in x for x in cl))
for dom in ('legacyPaneKeyAliasEntries', 'worktreeIdentityAliases'):
    v = json.loads(db.execute("SELECT payload FROM profile_state_documents WHERE domain=?", (dom,)).fetchone()[0])
    print(dom, type(v).__name__, len(v))
print('aiVaultTitle keys:', sorted({k for ts in ws['unifiedTabs'].values() for t in ts for k in (t.get('aiVaultTitle') or {})}))
print('tabs with aiVaultTitle.sessionId', sum(1 for ts in ws['unifiedTabs'].values() for t in ts if (t.get('aiVaultTitle') or {}).get('sessionId')))

print('\n== E3/E4 live sessions ==')
idx = {}
for f in glob.glob(f'{HOME}/.claude/projects/*/*.jsonl'): idx.setdefault(os.path.basename(f)[:-6], []).append(f)
tabsid = {(t['aiVaultTitle'] or {}).get('sessionId'): t['entityId'] for ts in ws['unifiedTabs'].values() for t in ts if t.get('aiVaultTitle')}
old = json.load(open(f'{PROFILE}/orca-data.json'))['workspaceSession']['sleepingAgentSessionsByPaneKey']
old_by_id = {v['providerSession']['id']: v for v in old.values()}
now_by_id = {v['providerSession']['id']: v for v in now.values()}
sess0 = json.load(open(glob.glob(f'{HOME}/.claude/sessions/*.json')[0]))
print('sessions/<pid>.json keys:', sorted(sess0.keys()))
print('nameSource values', dict(collections.Counter(json.load(open(f)).get('nameSource') for f in glob.glob(f'{HOME}/.claude/sessions/*.json'))))
env_names = set()
started = []; versions = collections.Counter(); sids_list = []
live = {}; join = collections.Counter(); first_old = 0
for f in glob.glob(f'{HOME}/.claude/sessions/*.json'):
    d = json.load(open(f)); pid = d['pid']; sid = d['sessionId']
    args = open(f'/proc/{pid}/cmdline').read().split('\0')
    env = dict(e.split('=', 1) for e in open(f'/proc/{pid}/environ').read().split('\0') if e.startswith('ORCA_'))
    rid = next((args[i + 1] for i, a in enumerate(args) if a in ('-r', '--resume') and i + 1 < len(args) and args[i + 1]), None)
    bare = any(a in ('-r', '--resume') for a in args) and rid is None
    started.append(d['startedAt'] / 1000); versions[d['version']] += 1; sids_list.append(sid)
    env_names.update(k for k in env)
    live[sid] = (env.get('ORCA_PANE_KEY'), rid == sid, bare)
    sl = now_by_id.get(sid)
    join[('resumed_with_id' if rid else 'bare_-r' if bare else 'no_-r', 'sleeping_has_id', sl is not None,
          'sleeping_key==ORCA_PANE_KEY', (sl['paneKey'] == env.get('ORCA_PANE_KEY')) if sl else None,
          'aiVault_has_id', sid in tabsid, 'tab==ORCA_TAB_ID', (tabsid[sid] == env.get('ORCA_TAB_ID')) if sid in tabsid else None)] += 1
    if rid and sid in idx:
        with open(idx[sid][0]) as fh:
            for l in fh:
                try: o = json.loads(l)
                except ValueError: continue
                if 'timestamp' in o:
                    first_old += datetime.datetime.fromisoformat(o['timestamp'].replace('Z', '+00:00')).timestamp() < BOOT; break
for k, v in sorted(join.items(), key=str): print(v, k)
print('ORCA_* env names seen:', sorted(env_names))
print('live sessions', len(sids_list), 'distinct sessionIds', len(set(sids_list)), '| versions', dict(versions), '| earliest startedAt - boot (s):', round(min(started) - BOOT), '| all after boot:', min(started) > BOOT)
print('resumed with id (id == sessionId):', sum(v[1] for v in live.values()), '| transcript first record before boot:', first_old)
files = [f for fs in idx.values() for f in fs]
post = [f for f in files if os.path.getmtime(f) >= BOOT]
only = 0
for f in post:
    ids = set()
    with open(f) as fh:
        for i, l in enumerate(fh):
            if i >= 400: break
            try: ids.add(json.loads(l).get('sessionId'))
            except ValueError: pass
    only += ids - {None} == {os.path.basename(f)[:-6]}
print('transcripts', len(files), 'changed after boot', len(post), 'file name is the only sessionId (first 400 lines)', only)

print('\n== E5 10-09 snapshot vs now ==')
shared = set(old_by_id) & set(now_by_id)
print('snapshot size:', len(old_by_id), '| shared ids:', len(shared), '| snapshot ids absent now:', len(set(old_by_id) - set(now_by_id)))
print('live resumed with id, id in 10-09 snapshot:', sum(1 for s, v in live.items() if v[1] and s in old_by_id))
for label, ids in (('shared & live --resume process', [s for s in shared if s in live and live[s][1]]), ('shared & live process, not --resume', [s for s in shared if s in live and not live[s][1]]), ('shared & no live process (stale)', [s for s in shared if s not in live])):
    ch = [s for s in ids if old_by_id[s]['paneKey'] != now_by_id[s]['paneKey']]
    both = [s for s in ch if old_by_id[s]['tabId'] != now_by_id[s]['tabId'] and old_by_id[s]['paneKey'].split(':')[1] != now_by_id[s]['paneKey'].split(':')[1]]
    print(f'{label}: n={len(ids)} paneKey_changed={len(ch)} (tab and leaf both differ: {len(both)}) worktree_same={sum(old_by_id[s]["worktreeId"] == now_by_id[s]["worktreeId"] for s in ids)}'
          f' title_same={sum(old_by_id[s]["terminalTitle"] == now_by_id[s]["terminalTitle"] for s in ids)}')
print('capturedAt of stale records that changed paneKey, minus boot (s):', [round(now_by_id[i]['capturedAt'] / 1000 - BOOT) for i in shared if i not in live and old_by_id[i]['paneKey'] != now_by_id[i]['paneKey']])
okeys = collections.Counter(k for v in old.values() for k in v)
print('snapshot entry fields (count of', len(old), 'entries):', dict(okeys))
print('handle/incarnation/ptyId fields in any snapshot entry:', sorted(set(okeys) & {'handle', 'incarnationId', 'ptyId'}))
print('snapshot entries with launchConfig:', sum('launchConfig' in v for v in old.values()), '| launchConfig keys:', sorted({k for v in old.values() for k in (v.get('launchConfig') or {})}))

print('\n== E6 entries with no live claude process ==')
livekeys = {v[0] for v in live.values()}
tabs = {t['id'] for ts in ws['tabsByWorktree'].values() for t in ts}
tomb = ws['closedTerminalTabTombstonesByTabId']
now_ms = datetime.datetime.now().timestamp() * 1000
stale = [v for k, v in now.items() if k not in livekeys]
print('n', len(stale), 'captured before boot', sum(v['capturedAt'] < BOOT * 1000 for v in stale), 'tab in tabsByWorktree', sum(v['tabId'] in tabs for v in stale),
      'tombstone', sum(v['tabId'] in tomb for v in stale), 'transcript on disk', sum(v['providerSession']['id'] in idx for v in stale),
      'agents', dict(collections.Counter(v['agent'] for v in stale)), 'states', dict(collections.Counter(v['state'] for v in stale)), 'origin', dict(collections.Counter(v['origin'] for v in stale)))
print('age hours', sorted(round((now_ms - v['capturedAt']) / 3.6e6, 1) for v in stale))
print('stale ids in the 14 shared', sum(1 for v in stale if v['providerSession']['id'] in shared))
```
