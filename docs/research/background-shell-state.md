# Background-shell agent state in Orca

Research for issue #101. Captured 2026-10-12 on Linux. Claude Code v2.1.296 with Sonnet 5.5 (the version was read from the startup banner of the first `terminal read`; that output was not saved).
No `src/` or test change. The CLI is `orca-ide`.

## Answer in short

1. Yes, `worktree ps --json` shows a signal that separated the two cases in this run. In case (b) the agent row has `state: "working"` but `mainAgent.state: "done"`. In case (a) both are `working`. Case (b) also had `workingMode: "monitoring"`. This rests on one run per case, one agent type and one kind of background work (see the table under Questions and the [Recommendation](#recommendation)).
2. Yes, `lastAssistantMessage` is set in case (b). It holds the reply of the turn that ended, so a reply can be read. The next turn (started when the shell ends) replaces it. Whether a token sent to an agent in case (b) produces a changed reply was not tested.
3. `terminal wait --for tui-idle` followed the screen, not the agent, in the observed runs. It timed out mid-turn (case a) and returned at once in case (b). It cannot tell case (b) from a finished turn.

## Method

- Created one throwaway terminal and started a Claude Code session there. Sent three prompts, only to that terminal's handle. No other terminal was read, written or waited on. The built CLI (`orca-broadcast`) was not run.
- After each prompt, ran a capture script. It prints only the rows of the throwaway terminal (matched by its `paneKey` and `handle`).
- Closed the throwaway terminal at the end. `terminal list` no longer showed its handle, and `ps -eo args` showed no `time.sleep(240)` process (both counted `0` after the close; neither output was saved as a file).

Redaction: ids (`paneKey`, `handle`, `ptyId`, `worktreeId`, `tabId`, `leafId`, `incarnationId`, `repoId`), paths, the user name and the shell prompt text are replaced by placeholders. Timestamps are kept. Rows are trimmed only where said.

### Commands

```sh
# 1. Create the throwaway terminal (in this worktree)
orca-ide terminal create --worktree path:<worktree> --title "THROWAWAY-101" --json
# 2. Start Claude Code in it
orca-ide terminal send --terminal <handle> --text "claude --model sonnet --allowedTools Bash" --enter --json
# 3. Prompts (one terminal only)
orca-ide terminal send --terminal <handle> --text '<prompt>' --enter --json
# 4. Capture, after each prompt: the agent row and the terminal row
orca-ide worktree ps --json | python3 -I -c "
import json,sys
d=json.load(sys.stdin)
for w in d['result']['worktrees']:
    for a in w.get('agents',[]):
        if a['paneKey']=='<paneKey>': print(json.dumps({'worktree_status':w['status'],'agent':a},indent=1))"
orca-ide terminal list --json | python3 -I -c "
import json,sys
d=json.load(sys.stdin)
for t in d['result']['terminals']:
    if t['handle']=='<handle>': print(json.dumps(t,indent=1))"
# 5. Wait (mid-turn in case a, during the shell in case b, after the turn)
orca-ide terminal wait --terminal <handle> --for tui-idle --timeout-ms 15000 --json   # case (a), mid-turn
orca-ide terminal wait --terminal <handle> --for tui-idle --timeout-ms 20000 --json   # case (b)
orca-ide terminal wait --terminal <handle> --for tui-idle --timeout-ms 90000 --json   # end of case (a)
# 6. Read the screen
orca-ide terminal read --terminal <handle> --json
# 7. Fleet-wide counts (read-only, no content)
orca-ide worktree ps --json   # grouped by state, workingMode, mainAgent.state
# 8. Close
orca-ide terminal send --terminal <handle> --text "/exit" --enter --json
orca-ide terminal close --terminal <handle> --tab --json
```

The first prompt of the session was `Run this Bash command in the foreground and wait: sleep 45 ; then reply with exactly: FG-DONE-1`. Claude refused it (Claude reported that the system blocked a lone `sleep`). The `terminal list` preview after it showed the text `Use option 1, run it in the background`. I did not send that text. I believe it was Claude's input suggestion, but I did not confirm this. Claude's own reply said it did not run the `sleep 45`, though the screen also showed `Ran 1 shell command` under that prompt. The case (a) row below shows `mainAgent.state: "working"` and no `workingMode`, so it is a normal working turn. The first prompt is not used as evidence.

## Case (a): agent working on a turn (foreground tool)

Prompt:

> Run in the foreground with the Bash tool, and wait for it: python3 -c "import time; time.sleep(60)". Then reply with exactly the line: FG-DONE-1

Capture 20 s into the turn (`taskTitle` and `displayName`, both `null`, are kept; nothing is omitted):

```json
{
 "worktree_status": "working",
 "agent": {
  "paneKey": "<tabId>:<leafId>",
  "parentPaneKey": null,
  "state": "working",
  "agentType": "claude",
  "prompt": "Run in the foreground with the Bash tool, and wait for it: python3 -c \"import time; time.sleep(60)\". Then reply with exactly the line: FG-DONE-1",
  "taskTitle": null,
  "displayName": null,
  "lastAssistantMessage": null,
  "toolName": "Bash",
  "toolInput": "python3 -c \"import time; time.sleep(60)\"",
  "interrupted": false,
  "mainAgent": { "state": "working", "stateStartedAt": 1791839979710 },
  "stateStartedAt": 1791839979710,
  "updatedAt": 1791839981476
 }
}
{
 "handle": "<handle>",
 "ptyId": "<repoId>::<worktree>@@<n>",
 "incarnationId": "<incarnationId>",
 "orphaned": false,
 "worktreeId": "<repoId>::<worktree>",
 "worktreePath": "<worktree>",
 "branch": "refs/heads/<branch>",
 "tabId": "<tabId>",
 "leafId": "<leafId>",
 "title": "◑ Foreground sleep command",
 "connected": true,
 "writable": true,
 "lastOutputAt": 1791840000298,
 "preview": "<shell prompt line>\nBoondoggling…",
 "executionHostId": "local",
 "agentIdentity": "claude"
}
```

`orca-ide terminal wait --terminal <handle> --for tui-idle --timeout-ms 15000 --json` mid-turn (took 15.3 s, the full timeout):

```json
{ "ok": false, "error": { "code": "timeout", "message": "timeout" } }
```

After the turn ended, the same wait with `--timeout-ms 90000` returned `"satisfied": true` (the timeout values in these commands are as typed; they are not in the saved output, and the saved output of this wait has no timing). The agent row then:

```json
{
  "paneKey": "<tabId>:<leafId>",
  "state": "done",
  "lastAssistantMessage": "FG-DONE-1",
  "toolName": "Bash",
  "toolInput": "python3 -c \"import time; time.sleep(60)\"",
  "mainAgent": { "state": "done", "stateStartedAt": 1791840043299 },
  "stateStartedAt": 1791840043299,
  "updatedAt": 1791840043299
}
```
(trimmed: `parentPaneKey`, `agentType`, `prompt`, `taskTitle`, `displayName`, `interrupted` omitted)

`toolName` and `toolInput` stay set after a turn that used a tool; they were `null` after the wake turn in case (b). They do not show that a tool is running.

## Case (b): turn ended, background shell still running

Prompt:

> Use the Bash tool with run_in_background set to true to run: python3 -c "import time; time.sleep(240)". Do not wait for it. Right after you start it, end your turn with exactly the line: BG-STARTED-2

The screen footer, read after the turn (the footer count is live, so it does not date a shell to a turn; it is corroboration only and the row fields are the evidence), showed `✻ Churned for 4s · done 6:20 PM · 1 shell still running` and the status line `⏵⏵ auto mode on · 1 shell`. The agent's reply was `BG-STARTED-2`.

Capture about 25 s after `stateStartedAt` (full rows):

```json
{
 "worktree_status": "working",
 "agent": {
  "paneKey": "<tabId>:<leafId>",
  "parentPaneKey": null,
  "state": "working",
  "workingMode": "monitoring",
  "agentType": "claude",
  "prompt": "Use the Bash tool with run_in_background set to true to run: python3 -c \"import time; time.sleep(240)\". Do not wait for it. Right after you start it, end your turn with exactly the line: BG-STARTED-2",
  "taskTitle": null,
  "displayName": null,
  "lastAssistantMessage": "BG-STARTED-2",
  "toolName": "Bash",
  "toolInput": "python3 -c \"import time; time.sleep(240)\"",
  "interrupted": false,
  "mainAgent": { "state": "done", "stateStartedAt": 1791840059170 },
  "stateStartedAt": 1791840055333,
  "updatedAt": 1791840059170
 }
}
{
 "handle": "<handle>",
 "ptyId": "<repoId>::<worktree>@@<n>",
 "incarnationId": "<incarnationId>",
 "orphaned": false,
 "worktreeId": "<repoId>::<worktree>",
 "worktreePath": "<worktree>",
 "branch": "refs/heads/<branch>",
 "tabId": "<tabId>",
 "leafId": "<leafId>",
 "title": "✳ Foreground sleep command",
 "connected": true,
 "writable": true,
 "lastOutputAt": 1791840060124,
 "preview": "<shell prompt line>\n8",
 "executionHostId": "local",
 "agentIdentity": "claude"
}
```

In this `preview`, the `8` appears to be a stray screen character.

The agent row was identical in every field at about 97 s and about 214 s after `stateStartedAt` (the shell was still running). `stateStartedAt` (…055333) is older than `mainAgent.stateStartedAt` (…059170). `updatedAt` equals `mainAgent.stateStartedAt` (…059170, the end of the turn) and did not move while the shell ran.

`terminal wait --for tui-idle --timeout-ms 20000` during the shell (took 0.6 s):

```json
{ "ok": true, "result": { "wait": { "condition": "tui-idle", "satisfied": true, "status": "running", "exitCode": null } } }
```

This matches the Agent Brief of issue #101 (item 3: on 2026-10-12, `tui-idle` reported idle while `worktree ps` still said `working`): `tui-idle` says idle while `worktree ps` says `working`.

When the shell ended (about 4 min after the start), Claude started a new turn by itself. This row was captured after that turn had ended (no mid-turn sample):

```json
{
  "paneKey": "<tabId>:<leafId>",
  "state": "done",
  "lastAssistantMessage": "The background command finished with exit code 0. No action is needed.",
  "toolName": null,
  "toolInput": null,
  "mainAgent": { "state": "done", "stateStartedAt": 1791840300193 },
  "stateStartedAt": 1791840300193,
  "updatedAt": 1791840300193
}
```
(trimmed: `parentPaneKey`, `agentType`, `prompt`, `taskTitle`, `displayName`, `interrupted` omitted)

`workingMode` is absent again and the first reply (`BG-STARTED-2`) is replaced. The mid-turn state of a woken agent (`lastAssistantMessage: null`) is shown by the existing fixture `test/fixtures/worktree-ps-woken-midturn.json` (an older capture; not re-observed in this run).

## Questions

### 1. Which fields differ between (a) and (b)?

| Field (`worktree ps` agent row) | (a) working turn | (b) turn ended, shell running |
|---|---|---|
| `state` | `working` | `working` |
| `mainAgent.state` | `working` | **`done`** |
| `workingMode` | absent | `monitoring` |
| `lastAssistantMessage` | `null` | the reply of the ended turn |
| `toolName` / `toolInput` | the running tool | the tool that started the shell (stale) |
| `stateStartedAt` vs `mainAgent.stateStartedAt` | equal | `stateStartedAt` older |
| `updatedAt` (not a discriminator) | set about 2 s after the turn start (one sample only) | equals the turn end; frozen |

`updatedAt` is not a discriminator: the only (a) sample was taken 18 s after it was set.

`terminal list --json` has no state field. The only state-like differences are the `title` glyph and the `preview` spinner text (`◑` + spinner word in (a), `✳` + no spinner word in (b)). Those are display text and not a good signal.

Fleet-wide counts, taken at the end of the test, before the throwaway terminal was closed (so the throwaway agent is probably one of the 28; the time was not recorded). The call was read-only, and no terminal was read. Grouped by `state`, `workingMode`, `mainAgent.state`:

```
('done', None, 'done') 9
('working', 'monitoring', 'done') 9
('working', None, 'done') 3
('working', None, 'working') 7
```

So `state=working` with `mainAgent.state=done` is common on this machine (12 of 28 agents). Nine have `workingMode: "monitoring"`. I did not read those terminals, so I did not confirm the cause of the three without `workingMode`. They may be other background work (for example a subagent). The field pair probably marks "main turn ended, something else still runs" (at least for the nine `monitoring` rows), not "a shell" only.

The existing fixture `test/fixtures/worktree-ps-woken-working-token.json` (captured 2026-10-06 local time, 2026-10-07 00:16 UTC, from the fixture timestamps; the fixtures README gives the local date for the other fixtures) is a (b)-style row with `workingMode: "monitoring"` and no `mainAgent` field. So `mainAgent` was not present in the older capture, and `workingMode` alone may be the more stable marker.

### 2. Is `lastAssistantMessage` updated in (b)?

Yes. In (a) it was `null` in the mid-turn sample and held the reply only after the turn ended. In (b) it holds the ended turn's reply (`BG-STARTED-2`) while the agent stays `working`. A reply can be read. It is the old reply: a token that was in it before a message was sent proves nothing. When the shell ends and the agent wakes, the new turn replaces the reply.

### 3. Does `tui-idle` help?

In the observed runs it followed the screen. It was not satisfied during a working turn (timeout, case a) and was satisfied during (b) and when the (a) turn ended. It is true for both "done" and "turn ended, shell running", so it cannot separate (b) from a finished agent. It is not a replacement for the row fields.

## Recommendation

Tentative recommendation, one reporting change (the `broadcast` and `pause` rules below are consequences of it): treat a row with `state == "working"` and `mainAgent.state == "done"` as a separate class, "turn ended, background work running" (for example status `background`), and do not count it as `still-working`. Caveat: 3 of 12 fleet rows with this pair have no `workingMode` and an unknown cause, so the class may be broader than "shell".

- `broadcast` (depends on the untested item under "Not tested"): keep the proof rule of `AGENTS.md`: an ack is a reply new since the send that ends with the exact `ORCA-ACK <token>` line, not a token already in the old reply. Report an agent in this class as `background` (not `still-working`) in the table until such a reply shows, and leave the exit code to the later ticket (out of scope here, as in the Brief).
- `pause` (same dependency): a pause sent to an agent already in this class is untested. Report it `unconfirmed` with reason `background` until a reply that is new since the send holds this pause's own `ORCA-PAUSED <token>`. Warn that the agent may wake when the shell ends (its new reply replaces the token). The `-working-token` fixture shows a reply that holds a token in this state, but its token belongs to the pause of that earlier capture, not to a new pause, so it proves nothing for a new pause.

Cost and risks:

- `mainAgent` and `workingMode` are not documented. This run saw them on Claude Code v2.1.296 only (one agent type, one kind of background work, one run per case). The older fixture has `workingMode` without `mainAgent`. The adapter must treat a missing `mainAgent` as the old behaviour (`still-working`), or also accept `workingMode == "monitoring"`. A new fixture of the (b) row, with `mainAgent`, is needed.
- The pair also matches background work that may not be a shell, so the reason text must say "background work", not "shell".
- A woken agent replaces the reply, so a confirmation read in the background state can be undone later. `pause` must keep checking the reply as it does for the existing wake-up case.
- No change in `tui-idle` use is needed.

Not tested (the follow-up ticket must test the first item before it relies on the ack rule): a message sent to an agent that is in case (b) (it may start a new turn or not); other agent types; a `Monitor` tool as the background work; several shells at once.

## Fixture material

Redacted rows for a later fixture: the case (a) capture and the case (b) capture above (agent rows).
