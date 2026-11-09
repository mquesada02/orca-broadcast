# Research: `orca-ide terminal send` to a Claude Code TUI that is mid-turn (issue #3)

Date: 2026-10-05. Claude Code v2.1.289 (Haiku 4.5), Orca local host, Linux.

## Direct answer

1. **The text is queued, not lost and not an interrupt.** Claude Code treats Enter pressed while a turn runs as "queue message". A queued message is passed to the model as soon as the running tool call(s) finish, inside the same turn; if still queued when the turn ends, it is sent automatically afterwards. Observed: the message was shown under the running tool as `ctrl+enter to send now`, then answered in the same turn after the tool finished (one reply, `ALPHA` + `BETA`).
2. **Receipts do not distinguish "queued" from "submitted".** With `--text ... --enter --wait-submit 10 --json` the receipt returned `accepted: true` and `stages: ["input_accepted","turn_started"]` in every case, including when the message only sat in Claude's queue. Do not read `turn_started` as "Claude is now acting on this message" when the agent was already working.
3. **Orca agent state** (`worktree ps --json` -> `agents[].state`): `working` while the turn runs, `waiting` while a permission prompt is open, `done` when the turn ends (with `lastAssistantMessage` filled). A message sent mid-turn does not itself create a new working/done cycle; `done` came once, after the queued message had been answered.
4. **Permission prompts are the trap.** If the agent is blocked on a permission dialog (`waiting`), keystrokes go to the dialog, not to the prompt box (not tested with text; a bare Enter accepted the highlighted "Yes"). The first-seen Orca state `waiting` was stale for a few seconds after the dialog was answered.

Implication for `pause`: a graceful pause message sent to a `working` agent will be queued and delivered after the current tool call, in the same turn. That matches the intended "finish the current step, then stop" semantics, but proof of delivery must come from the agent reaching `done` / terminal output, not from the receipt.

## Evidence

### Docs (primary)
- Claude Code docs, "Queue messages while Claude works" (https://code.claude.com/docs/en/interactive-mode.md): "Type a message and press `Enter` while Claude is working. Claude Code queues the message instead of interrupting the turn". Delivery: "if you queue a message while Claude is running tool calls, Claude Code passes it to Claude as soon as those tool calls finish, within the same turn. When the turn ends with messages still queued, they go out without another key press, in the order you typed them". Commands and `!` shell commands are held until the turn ends. Some commands (`/model`, `/effort`, `/fast`, `/status`) run immediately instead of queueing.
- Same page: `Esc` interrupts; queued messages are then sent. `Ctrl+Enter` sends queued messages now (and can move foreground work to background).
- `orca-ide skills get orca-cli`, Terminals section: "`accepted: true` proves input acceptance, not a started turn. Use the receipt's `turn_started` stage when submission proof is needed; never resend on silence." "A default send observes for 0 seconds, so a receipt that stops at `input_accepted` is expected ... means 'unproven', not 'failed'." "`--wait-submit <seconds>` only observes the same accepted prompt. A timeout returns queued/input-accepted truth without resending."
- `orca-ide terminal send --help`: same, plus `--retry-request <id>` for idempotent retry bound to prompt payload and process incarnation.
- Neither Orca source says what stages report when the agent is already mid-turn. That is only answered by the experiment below.

### Experiments (throwaway terminal `research-probe`, Claude Haiku 4.5, in this worktree)
Times are local, 13:03-13:07.

| # | Situation when 2nd message sent | Receipt | Result |
|---|---|---|---|
| A | Prompt 1 asked for `sleep 40`. Claude Code's hook/policy blocked standalone sleep and Claude ran it in background; the turn had in fact ended (`done 1:03 PM . 1 shell still running`) while ps still said `working` | `input_accepted`, `turn_started` | Processed as a new turn immediately. Not a valid mid-turn test. |
| B | Same race with a blocked-sleep refusal | same | Also turned out to be post-turn. Not valid. |
| C (valid) | Foreground tool running: `python3 -c 'import time; time.sleep(45)'`, spinner `Newspapering...` at ~17s | `input_accepted`, `turn_started` (observed within the 10 s window) | Terminal showed the text under the tool as queued with `ctrl+enter to send now`. After the tool finished, one reply `ALPHA` / `BETA`, a single turn (`Crunched for 50s`). Nothing lost, nothing interrupted. |

Receipt for C: `{"stages":["input_accepted","turn_started"],"provider":"claude","observation":"supported","baselineWorkingSequence":7,"baselineExplicitWorkingStartedAt":null,"baselinePermissionSequence":0}`. Prompt 1's first receipt (idle agent) had the same stages with baselineWorkingSequence 0.

Possible false positive (inference, not verified): in C the agent had just left `waiting` (permission prompt) and Orca's state flipped to `working` (stateStartedAt 13:06:05) right when the send returned, so `turn_started` may have been satisfied by that transition rather than by the queued message. Orca's receipt logic is closed-source here; treat `turn_started` as weak evidence for mid-turn sends.

### Orca agent state over time (`worktree ps --json`, `agents[]` for the probe pane)
- 13:03:46 `working` (after prompt 1; `stateStartedAt` 1791216226718).
- Race case A: `working` persisted ~1 min while a background shell and queued turns ran; `done` at ~13:04:35 with `lastAssistantMessage` "DONE|PONG".
- Permission dialog (manual mode, `python3 *` not allowed): `waiting`, `toolName: Bash`, `toolInput: python3 -c 'import time; time.sleep(45)'`. After answering Yes it still read `waiting` at 13:05:56, flipped to `working` by 13:06:05.
- 13:06:28 `working`; 13:06:35-37 `done` (`stateStartedAt` 1791216395063), `lastAssistantMessage` "ALPHA|BETA". Stayed `done` for 30 s of sampling.
- So: `working` -> `done` happens when the turn (including the queued message) ends; `done` is not "stopped waiting for CONTINUE", it is simply "idle at the prompt".

## Findings for the probe itself
- The probe ran in manual permission mode; the first Bash call needed approval. Permission prompts are a real blocker for unattended agents and show as `waiting`.
- A user-level policy blocked a bare `sleep`; use another busy command when testing.

## Open questions
1. Does `turn_started` ever fail to appear for a mid-turn send? Not reproduced; a send during streaming (no tool running, so no tool boundary) was not tested.
2. Behavior when text is sent while a permission dialog is open: not tested with text (only a bare Enter).
3. Whether a queued message is delivered after a mid-turn tool boundary or only at turn end when the model is only streaming: docs say tool-call boundary, only the tool case was observed.
4. Does `pause` need to distinguish a paused agent (`done`) from a finished agent? `done` looks identical; the pause record must be kept externally.
5. Behavior of other Claude Code versions, other models, and `--wait-submit` with timeouts below the time to the first state change.
