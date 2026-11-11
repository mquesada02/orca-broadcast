# What the Orca CLI sees and does with restored, agent-less tabs

Research for issue #241. Captured 2026-11-11 on Linux, Orca 1.4.255 (`orca --version`). Read-only: no `orca-broadcast` run, no `terminal send`, no create, close, rename, split or focus. The state database was read from a copy. Ids below are placeholders.

Situation: the PC rebooted at 10:04 local time. After the reboot a `recover` started new agents. The question is about the tabs that Orca restored from before the reboot, where no agent runs.

## Answer in short

1. **Restored tabs are invisible to every read-only CLI command I ran.** `terminal list --json` (34 terminals, none `orphaned`), `terminal list --include-visual-layouts --json` (34 tabs, 34 terminal panes, every pane has a `handle`) and `worktree ps --json` (90 worktrees, 24 agents) list only tabs with a live PTY. Orca's stored layout holds 78 terminal tabs; 44 of them have no live terminal. All 44 were created before the reboot. None of the 44 appears in `visualLayouts` or in a `worktree ps` agent row. All 34 live tabs were created after the reboot.
2. **The stored records keep `tabId` and `leafId`, and the stored layout is on disk.** Not in `orca-data.json` (a stale export, last written 2026-10-09) but in `~/.config/orca/profiles/<profileId>/profile-state.db` (SQLite, domain `workspaceSession`). The 44 restored tabs kept their pre-reboot ids, since their `createdAt` is before the boot. The record holds tab id, leaf id, title, custom title, launch agent and a pty id. It holds no cwd and no last command per tab (the worktree id gives the directory). Details below.
3. **The CLI cannot target a restored tab.** Every command that acts on a tab or pane (`send`, `read`, `show`, `split`, `close`, `rename`, `set-pane-title`, `switch`, `wait`) takes `--terminal <handle>`. A handle is "runtime-issued" and exists only for a live terminal. There is no `--tab`, `--pane` or `--leaf` selector. `terminal create` and `agent launch` always make a new tab. The one handle-free close, `terminal close --worktree <selector> --all`, "durably removes its terminal tabs, layouts, and resume records" for the whole workspace, live tabs included.
4. **No documented or stable marker for a restored tab.** Nothing in `terminal list`, `show` or `worktree ps` flags one. A restored tab is recognisable only by absence: its pane key has no row in `terminal list`. Orca's database does mark such a tab (stored, no live PTY, created before boot), but that is an internal file, not a documented interface.

## Evidence

### Orca version and docs

- `orca --version`: 1.4.255.
- Session restore (https://www.onorca.dev/docs/model/session-restore): on every launch Orca restores open worktrees, tabs and splits, scrollback, and the focused worktree and tab. A running agent survives an Orca quit because a daemon owns the PTYs. After a host reboot "the daemon dies and every running agent ends. Worktrees, tabs, splits, and the last-persisted scrollback still come back, but you must re-run the agent in each tab." The page names no CLI command and no files on disk.
- Tabs, panes and splits (https://www.onorca.dev/docs/model/tabs-panes-splits): each tab has a stable id (UI "Copy Tab ID"); layout is saved per worktree. It does not mention the CLI or restore.
- Agents and sessions (https://www.onorca.dev/docs/model/agents-sessions): when an agent exits, "the tab shows a Restart chip. One click rehydrates the same agent with the same working directory." This is a UI action. I found no CLI equivalent.
- Agent hibernation (https://www.onorca.dev/docs/agents/hibernation): opening a sleeping worktree relaunches the agent with the same resume flags, with nothing to click. It names no Orca command; `claude --resume <id>` is the provider's own command. This covers workspace Sleep, not a reboot (see the unverified list).
- `orca skills get orca-cli`: "Handles are runtime-scoped: after an Orca restart or a `terminal_handle_stale` error, re-list and continue with the replacement only." It also says `terminal close --worktree <selector> --all` removes "terminal tabs, layouts, and agent-resume records", and to use workspace Sleep, not close, when sessions should resume later.

### Question 1: CLI output

Commands run: `orca terminal list --json`, `orca terminal list --include-visual-layouts --json`, `orca worktree ps --json`.

- `terminal list --json`: top keys `hostScope`, `terminals`, `topologyRevisions`, `totalCount`, `truncated`. Row keys: `agentIdentity`, `branch`, `connected`, `executionHostId`, `handle`, `incarnationId`, `lastOutputAt`, `leafId`, `orphaned`, `preview`, `ptyId`, `tabId`, `title`, `worktreeId`, `worktreePath`, `writable`. 34 rows, 0 with `orphaned: true`.
- `--include-visual-layouts`: 28 worktrees; each has `worktreeId`, `worktreePath`, `root` (groups with `tabs[]` of `tabId`, `title`, `activeLeafId`, `panes`). 34 tabs, every terminal pane has a `handle`. A stored tab without a live PTY does not appear.
- `worktree ps --json`: worktree rows have `liveTerminalCount`, `hasAttachedPty`, `unverifiableTerminalCount` and others. Agent rows have `paneKey`, `state`, `hasLivePty` and others. 62 of 90 worktrees have `liveTerminalCount: 0` and `hasAttachedPty: false`. No agent row has the pane key of any of the 44 restored tabs. `terminal list` has no flag for "include tabs without a PTY"; `--help` lists only `--worktree`, `--limit`, `--include-visual-layouts`.
- `worktree show` has only `--worktree`; I did not run it per worktree. Its `--help` shows no terminal or tab option.
- The `orphaned` flag means something else. From the earlier note `terminal-identity.md`: an orphan is a PTY with no UI tab (synthetic `pty:<ptyId>` ids). A restored tab is the reverse: a UI tab with no PTY. So `orphaned: true` never marks a restored tab.

### Question 2: ids and the on-disk layout

File: `~/.config/orca/profiles/<profileId>/profile-state.db` (SQLite; `-wal` and `-shm` beside it; hourly `profile-state.db.backup.<ms>-<uuid>.db`). I read a copy of the three files. Tables: `profile_state_meta`, `profile_state_documents` (one row per top-level domain), `profile_state_document_parts` (large domains split into parts, keyed `domain` + `part_key`, where `part_key` is a JSON array path such as `["tabsByWorktree","<worktreeId>"]`).

`orca-data.json` and `orca-data.json.sqlite-export.*.json` in the same folder are older exports (last written 2026-10-09); their tab ids match no live terminal. Do not read them for current state. `~/.config/orca/terminal-history/<hash>/` holds scrollback per pty; I did not open it.

The `workspaceSession` domain holds these maps (counts from this PC after the reboot):

| Map (part key first element) | Key | Value fields |
|---|---|---|
| `tabsByWorktree` | `<worktreeId>` | list of tab records: `id` (the tabId), `ptyId`, `worktreeId`, `title`, `defaultTitle`, `customTitle`, `color`, `sortOrder`, `createdAt`, `launchAgent` (`claude` on 12 of 78, else null), `aiVaultTitle` |
| `terminalLayoutsByTabId` | `<tabId>` | `root` (split tree with `leafId`), `activeLeafId`, `expandedLeafId`, `ptyIdsByLeafId` (`<leafId>` -> ptyId), `titlesByLeafId` |
| `terminalPtyIncarnationsByPaneKey` | `<tabId>:<leafId>` | incarnation string |
| `sleepingAgentSessionsByPaneKey` | `<tabId>:<leafId>` | `paneKey`, `tabId`, `worktreeId`, `agent`, `providerSession` (`key`, `id`, `transcriptPath`, `cwd`, `effort`), `prompt`, `state`, `capturedAt`, `updatedAt`, `terminalTitle`, `mainAgent`, `origin`, `connectionId` |
| `closedTerminalTabTombstonesByTabId` | `<tabId>` | `closedAt`, `reason`, `worktreeId` |
| `unifiedTabs`, `tabGroups`, `tabGroupLayouts` | `<worktreeId>` | UI tab order and groups (`contentType`: `terminal` or `editor`) |

Facts from comparing the database with the CLI:

- 78 stored terminal tabs, 78 layouts, 78 leaves (one leaf each). 34 match a live terminal by `tabId` and `leafId`; 44 do not.
- Tab ids survive a reboot: all 44 non-live tabs have `createdAt` before the boot and are still stored with their ids. The leaf id is stored with them in `terminalLayoutsByTabId`. The 34 live tabs were all created after the boot, so I could not check whether a tab that was live before and after the reboot keeps its `leafId` in the running UI.
- Of the 44 restored tabs, 6 have `launchAgent: claude` and 6 have a `sleepingAgentSessionsByPaneKey` entry (with the Claude session `id`, `transcriptPath` and `cwd`). The other 38 have no stored agent session. Among the 34 live tabs, 23 have such an entry.
- 9 of the 44 have a `customTitle`; 10 have a title that differs from `defaultTitle`.
- Stored per tab there is no cwd and no last command. `cwd` exists only inside `providerSession` of a sleeping entry. The worktree id maps to the directory (`worktreeMeta`).
- 39 worktrees hold the 44 restored tabs; 20 of those are in `worktree ps` (their `liveTerminalCount` is 0 for 15 and 1 for 5). The rest are not listed by `worktree ps`; I did not find out why (archived, removed or hidden).

### Question 3: what the CLI can do to a tab

From `orca terminal --help` and each `--help` (1.4.255):

| Command | Target | Effect on a restored tab |
|---|---|---|
| `send`, `read`, `show`, `wait` | `--terminal <handle>` | Needs a live handle. A restored tab has none. |
| `split` | `--terminal <handle>` | Same. Always adds a new pane. |
| `close` | `--terminal <handle>` [`--tab`], or `--worktree <selector> --all` | Per-tab close needs a handle. `--all` removes every tab, layout and resume record of the workspace, live ones too, and stops their processes. |
| `rename`, `set-pane-title`, `switch` | `--terminal <handle>` | Same. |
| `create` | `--worktree <selector>` | Always a new tab (`--command` runs in it). |
| `agent launch` | `--worktree <selector>` | Starts a new agent in a new tab. The help says "Start an agent in an existing workspace"; no option selects an existing tab or session. No `agent resume` command exists (`Unknown command: agent resume`). |

No `--tab`, `--pane` or `--leaf` option exists anywhere. `orca search` reads session text (and returns a `resumeCommand`), but it does not touch tabs.

### Question 4: telling restored from live

- No field in `terminal list`, `terminal show`, `visualLayouts` or `worktree ps` marks a tab as restored. The docs name none.
- `worktree ps` gives `liveTerminalCount` and `hasAttachedPty` per worktree, but a restored tab is not counted in either.
- Derived rule, not documented: a pane key that has no row in `terminal list` is not live. But a restored tab is not in `terminal list` at all, so the CLI cannot even show the pane key. The pane key is only in the database.
- Database rule, not a stable interface: a record in `tabsByWorktree` with no row in `terminal list` and a `createdAt` before the boot.

## Not verified

- Whether opening a worktree in the Orca UI turns a restored tab into a live one (with a handle, and a started shell). I only looked at one moment, and opening a worktree would change real state.
- Whether the Restart chip, or opening a sleeping worktree, resumes an agent in a restored tab after a reboot. The hibernation page covers sleep, not reboot. 6 restored tabs have a stored sleeping-agent entry, which suggests Orca could resume them, but I did not test it.
- Whether a tab that was live before and after a reboot keeps its `leafId` in the running UI (no such tab existed in this sample).
- Why 19 worktrees with restored tabs are not in `worktree ps`.
- The database is an internal format (`domain_version` per domain). It can change between Orca versions.

## Fixes the facts allow

- **(a) Resume inside the restored tab: not possible with the CLI.** Every command that writes to a tab needs a live `--terminal <handle>`, and a restored tab has none. `agent launch` and `terminal create` open a new tab. Writing to Orca's database is out of scope and unsafe (the app owns that file).
- **(b) Close the restored tab after starting the new one: not possible per tab.** `terminal close` needs a handle. The only handle-free close, `--worktree <selector> --all`, also stops the new agent, because it removes every terminal in the workspace. It is not a fix. Closing the stale tab by hand in the UI works, and Orca then writes a tombstone (`closedTerminalTabTombstonesByTabId`).
- **(c) Neither, so an Orca feature request.** This is the supported conclusion for now. Candidate requests: list restored tabs in `terminal list` (with a `restored` or `hasPty: false` flag and the pane key); let `terminal send`, `close` and `agent launch` take a `--tab <tabId>` or `--pane <paneKey>`; or an `agent resume --pane <paneKey>` that uses the stored `sleepingAgentSessionsByPaneKey` entry.
