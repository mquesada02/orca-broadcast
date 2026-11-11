# Where to read every reply since a send

Research for issue #216 (map #215). Captured 2026-11-11 on Linux. Read-only: no `orca-broadcast` run, no `terminal send`, no write to any Claude or Orca file. Transcript text below is redacted and short.

## Answer in short

1. **Path.** The transcript is `<claude config dir>/projects/<slug>/<session id>.jsonl`. The slug is the session cwd with every character other than letters and digits replaced by `-`. This is the rule `src/orca-adapter.ts` already uses in `startAgent`. `CLAUDE_CONFIG_DIR` replaces `~/.claude` as the config dir. On this PC no Claude process sets it, `~/.config/orca/claude-accounts` is empty, and `claude-observed-config-dirs.json` lists only `~/.claude`. The adapter already maps pane key to session ID (`ORCA_PANE_KEY` from `/proc/<pid>/environ`, then `sessions/<pid>.json`). It needs the session cwd for the slug. That is in the same `sessions/<pid>.json` file (key `cwd`). The worktree path alone is not enough: one worktree dir held 31 transcripts.
2. **Format.** One JSON object per line. A reply is an `assistant` entry with a `text` block and `message.stop_reason == "end_turn"`. One API message is split over several entries, one per content block (thinking, text, tool_use), so text is not split inside one block, but a turn has many assistant entries, and mid-turn text entries have `stop_reason == "tool_use"`. A background-task wake-up turn starts with a `user` entry whose `origin.kind` is `task-notification` and `promptSource` is `system`. Every entry has an ISO 8601 UTC `timestamp` with milliseconds.
3. **Same text as `lastAssistantMessage`.** Yes. In 15 of 15 agents where the matching transcript could be chosen, Orca's `lastAssistantMessage` equalled the last assistant text block exactly (same length, same last line). The 2 other cases were a wrong file choice (shared worktree, newest file was another session); the exact text was found in an older file of that dir. 6 of 21 rows had `lastAssistantMessage` null (state working or waiting).
4. **Alternatives.** `orca terminal read` returns accumulated terminal output with escape sequences stripped (repainted TUI lines come back as fragments), or the rendered screen with `--screen`. It is bounded and has no per-reply boundary. `orca search` could search past assistant turns by agent and `--since`, but the index is disabled here (`unavailable`, reason `disabled`). `worktree ps --json` gives only the last reply per agent.
5. **Cost.** 1352 transcripts, 7.2 GB in total. Median 3.6 MB, p90 11.7 MB, max 70 MB. A full read per poll is too slow. A tail read works: in 162 of 164 recently active transcripts the last `end_turn` text entry was found within a backward scan; the median distance from the end of file was 13.6 KB, p90 394 KB, max 6 MB.

## Evidence

### 1. Path and config dir

- Docs (https://code.claude.com/docs/en/claude-directory, "Application data"): `projects/<project>/<session>.jsonl` is the "Conversation transcript". Same page: "If you set `CLAUDE_CONFIG_DIR`, every `~/.claude` path on this page lives under that directory instead."
- Docs (https://code.claude.com/docs/en/claude-directory, scratchpad section): `<project>` is "your working directory path with every character other than letters and digits replaced by `-`". The same rule matches `src/orca-adapter.ts` (`worktreePath.replace(/[^A-Za-z0-9]/g, '-')`).
- Docs: transcripts are deleted after `cleanupPeriodDays` (default 30). Subagent transcripts live in `projects/<project>/<session>/subagents/` (21541 such files here), not in the session file. A set-aside transcript can be renamed `<session>.orphaned-<ts>-<suffix>.jsonl` or `<session>.jsonl.superseded-<ts>`.
- Docs (https://code.claude.com/docs/en/env-vars): `CLAUDE_CONFIG_DIR` is path-valued and cannot be set from project or local settings. The page text I could read did not describe the transcript location; the claude-directory page above does.
- This PC: of 23 live `claude` processes, 0 had `CLAUDE_CONFIG_DIR` in `/proc/<pid>/environ`. 22 had `~/.claude/sessions/<pid>.json`. For all 22, `projects/<slug(cwd)>/<sessionId>.jsonl` existed, and the process cwd equalled the `cwd` key in the session file.
- `sessions/<pid>.json` keys seen: `cwd`, `sessionId`, `pid`, `procStart`, `startedAt`, `status`, `updatedAt`, `name`, `version`, `entrypoint`, `kind`, and others.
- `~/.config/orca/claude-accounts`: empty directory. `orca account list --json`: `claude.accounts` is `[]`. `~/.config/orca/claude-observed-config-dirs.json`: a JSON array with one entry, the default `~/.claude`.
- Docs: `sessions/` is not swept by age and a file is removed when the session exits, so a live PID has one.
- How to find the file from what is held: pane key -> pid (adapter, via environ) -> `sessions/<pid>.json` (trusted when `procStart` equals the live start time, as the adapter already checks) -> `cwd` + `sessionId` -> transcript. A per-process `CLAUDE_CONFIG_DIR` from `environ` should replace the default dir when set. The adapter does not read it today; it passes one `claudeDir` option.
- Risk seen in the worktree `ps` data: several agents share one worktree path, so the newest file in the slug dir is the wrong choice for some of them (2 of 17 compared).

### 2. Transcript format

Counts are from one ordinary 540-assistant-entry session of this project.

Top-level `type` values: `assistant`, `user`, `attachment`, `system` (subtypes `turn_duration`, `stop_hook_summary`, `informational`, `compact_boundary`), `queue-operation` (operations `enqueue`, `dequeue`, `remove`, `popAll`), `api-request`, `api-request-blob`, `mode`, `permission-mode`, `ai-title`, `last-prompt`, `pr-link`, `file-history-snapshot`, `file-history-delta`, `cost-state`, `tools-used`, and others. The set is not documented, so a reader should ignore unknown types.

`assistant` entry keys: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `isSidechain`, `cwd`, `message`, `requestId`, `gitBranch`, `version`, and others. `message` keys: `id`, `model`, `stop_reason`, `content`.

Split over entries. Counts of (stop_reason, content block types) per entry: (tool_use, [tool_use]) 283, (tool_use, [thinking]) 126, (tool_use, [text]) 62, (end_turn, [text]) 52, (end_turn, [thinking]) 15, (stop_sequence, [text]) 2. 278 distinct `message.id` values over 540 entries; 158 ids had more than one entry (a thinking entry then a tool_use or text entry, a few hundred ms apart). So:

- Each entry holds one content block. A `text` block is whole in one entry.
- The reply of a turn is the last `assistant` entry of the turn that has a `text` block with `stop_reason == "end_turn"`.
- Text with `stop_reason == "tool_use"` is mid-turn commentary, not the final reply.
- A thinking entry with `end_turn` precedes the text entry of the same message.
- Two `stop_sequence` entries had model `<synthetic>`; I did not look into them. Treat `isApiErrorMessage` / `<synthetic>` entries as not-a-reply until checked.
- Subagent (sidechain) entries are in separate files under `<session>/subagents/`, and carry `isSidechain`.
- Turn end marker: a `system` entry with `subtype` `turn_duration` follows the last assistant entry (also `stop_hook_summary` when Stop hooks ran).

Who started a turn: the `user` entry has `origin` (object) and `promptSource`:

- Human typing: `origin.kind == "human"`, `promptSource == "typed"`. The text arrived through the terminal, so a message sent by `orca terminal send` should look like this one. In an `orca-broadcast` session the content starts with `[orca-broadcast] The user sends you this message: ...`.
- Background task or subagent finished (wake-up): `origin == {kind: "task-notification", producer: "session-task", runId: ...}`, `promptSource == "system"`. The content is `<task-notification>` XML with `task-id`, `output-file`, `status`, `summary`. The same text also appears earlier as a `queue-operation` `enqueue` entry. In the sample, a wake-up user entry was followed within seconds by an assistant entry with `end_turn` and a text reply (a short summary of what the task reported), then `stop_hook_summary` and `turn_duration`.
- Peer message: `origin.kind == "peer"` with a `from` id; content starts `Another Claude session sent a message:`.
- Entries written while a turn runs can interleave; the order in the file is write order, so compare by `timestamp`, not by position alone. In the sample, a wake-up user entry at index 1015 was logged before a peer entry at 1023 that its own turn answered.

ORCA-ACK examples (found with `grep -l`, then parsed; text redacted): three assistant entries, each `stop_reason: end_turn`, one `text` block, `isSidechain: false`, with `ORCA-ACK <token>` as the last line after one or two short paragraphs, for example `...I keep waiting for the reply.\n\nORCA-ACK <token>`. The preceding human entry was `origin.kind: human`, `promptSource: typed`, about 4 seconds before. In one case the reply came 4 s after the user entry (`16:05:48.643Z` to `16:05:52.821Z`). 1221 transcript files here (subagent files included) contain the string `ORCA-ACK` (also in prompts and in quoted discussion), so a reader must match on assistant `text` blocks and a whole last line, not on the string anywhere. `ORCA-PAUSED` was found in the same way (also appears in prompts and docs).

### 3. `lastAssistantMessage` against the transcript

Command (the one the adapter uses): `orca worktree ps --json`. Each agent row has keys `activity`, `agentType`, `conversationName`, `displayName`, `hasLivePty`, `interrupted`, `lastAssistantMessage`, `mainAgent`, `paneKey`, `parentPaneKey`, `programStatus`, `prompt`, `state`, `stateStartedAt`, `taskTitle`, `toolInput`, `toolName`, `updatedAt`. No session ID.

Method: for each of the 21 agent rows, take the newest transcript in the slug dir of the worktree path, and compare `lastAssistantMessage` with the last non-empty `text` block of a non-sidechain assistant entry. Only `==`, length and last-line equality were printed.

Result for the 17 Claude rows with a non-null message and a transcript:

- 15 exact: equal string, equal length (145 to 2151 chars), equal last line, `stop_reason` `end_turn`. States: done and working.
- 2 differ only because the newest file in a shared worktree dir belonged to another session. The exact string was found as an `end_turn` text block in an older file of the same dir (sizes 9.7 MB and 23 MB). So the text rule holds; the file choice needs the session ID.
- 6 rows had `lastAssistantMessage` null (4 working, 2 waiting). A reader of the transcript still has the text.
- Some `working` rows already showed an exact match: Orca keeps the previous turn's reply while a new turn runs, and the transcript's newest text at that moment can still be the same one. A baseline comparison must therefore use the new entries after the send, not "equal to last".
- This is consistent with `docs/research/background-shell-state.md` (#101): `lastAssistantMessage` holds the reply of the turn that ended.

### 4. Orca alternatives

- `orca terminal read --help`: "Read bounded terminal output". Default output is accumulated, escape-stripped, so repainted TUI lines come back as stacked fragments. `--screen` returns the rendered frame, no history. `--cursor <n>` returns only new output (cursors come from the previous read); `--limit` default 120 lines for tail previews; the result reports `truncated`, `limited`, `oldestCursor`, `nextCursor`. Output is retained in a bounded buffer. It has no reply boundary, no timestamps, and wrapped lines and UI chrome are mixed in. I did not run it on any terminal here.
- `orca search --help`: full-text search of agent sessions with `--agent`, `--path`, `--since <iso>`, `--scope conversation` (user and assistant turns; tool output excluded), `--sort newest`, `--json`. `orca search --index-status --json` on this PC: `enabled: false`; `orca search "<q>" --json` returned `{"kind":"unavailable","reason":"disabled"}`. It is off by default here, it indexes sessions on a delay (`--fresh` waits up to 5 s), and it returns hits, not whole replies in order. Not a reliable source.
- `orca worktree ps --json`: only the last reply per agent (see section 3).
- Other places on disk (`~/.config/orca/terminal-history`, `agent-session-journal.db`, `claude-agent-view`) exist; I did not open them. They are Orca internals with no documented contract.

### 5. Cost

Counts and sizes only (no names), main-session transcripts, `find ~/.claude/projects -name '*.jsonl'` excluding `subagents/`:

| Measure | Value |
| --- | --- |
| Files | 1352 |
| Total | about 7.2 GB |
| Smallest | 461 bytes |
| Median | 3.6 MB |
| 90th percentile | 11.7 MB |
| Largest | 70 MB |
| Subagent transcripts (separate, ignorable) | 21541 |
| Files changed in the last 3 days | 164, of which the five largest are 20 MB to 58 MB |

Tail-read test on the 164 recently changed files (read backward in 64 KB chunks until an assistant `end_turn` text line was found): found in 162; distance from end of file to that entry: median 13.6 KB, p90 394 KB, max 6.0 MB; at most 92 chunks of 64 KB for the worst file. Entries can be large because `api-request-blob` and `attachment` entries (system prompt snapshots) and tool results sit in the same file.

Tail-read options:

- Remember a byte offset per agent: at send time record the file size; each poll, read from that offset to the end. Cost is proportional to new bytes only. Use `stat` first and skip when the size is unchanged. Only complete lines (ending in `\n`) count; keep a partial last line for the next poll.
- If the file is rewritten (size smaller than the saved offset, or the file replaced after `compact_boundary` or a `.superseded` rename), fall back to a backward scan and filter by `timestamp >= send time`.
- No need to parse every line: test the line for `"type":"assistant"` first, parse only those.
- Clock: entry timestamps are the Claude process clock (same PC here), in UTC with `Z`. The send time from orca-broadcast is the same PC clock; allow a small skew margin or prefer the byte offset.

## Open risks

- Wrong-file risk: the slug dir holds many transcripts per worktree. The session ID from `sessions/<pid>.json` must pick the file. A restart with `claude --resume` can keep the same session ID but writes to the same file; a fork or `/clear` starts a new session ID with a new file and a new `sessions/<pid>.json` content. Re-read `sessions/<pid>.json` on each poll or when the file stops growing.
- `CLAUDE_CONFIG_DIR`: not set on this PC, so the per-process path was never exercised. The adapter would need to read it from `environ` and use `<dir>/projects` and `<dir>/sessions`. I did not test a Claude process with it set.
- Entry order: entries can be written out of timestamp order around queued messages. A reader should select by `timestamp` and `message.id`, and take the last `end_turn` text, not the file's final line.
- Stop-hook output, `<synthetic>` error entries and `stop_sequence` entries are not documented. I saw them only in small counts.
- The transcript format is not a documented contract (docs only name the file path and call it a conversation transcript). A Claude Code update can change field names. A reader should ignore unknown entries and keep `lastAssistantMessage` as a cross-check.
- Retention: transcripts older than `cleanupPeriodDays` are deleted, and `CLAUDE_CODE_SKIP_PROMPT_HISTORY` skips writing transcripts, so a reply could have no file.
- Privacy: transcripts hold tool output and credentials in plaintext. A reader should keep only the reply text and the token line, never log entries.
- Orca `search` is disabled by default, so it cannot be counted on.
- Sample size for section 3 is one PC, 17 compared agents, one Claude Code version range.
