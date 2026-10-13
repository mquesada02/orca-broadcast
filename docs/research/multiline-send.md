# Multi-line text in `orca-ide terminal send` (research for #95)

Captured 2026-10-12 with Claude Code v2.1.296 (Sonnet 5.5) on Linux. Every test ran in throwaway terminals
created for this note (`orca-ide terminal create`), then closed with `orca-ide terminal close --terminal $H --json` (`ptyKilled: true`). Handles, ids and paths below are redacted
placeholders (`$H` is the throwaway terminal handle). No test used `orca-broadcast` or any other terminal.

## Answer in short

- A `\n` or `\r\n` in `--text` does **not** submit early. Claude Code receives the lines as one message, and the message
  is submitted once, by `--enter`.
- No extra option is needed. `terminal send` has no paste option, and sending bracketed-paste markers by hand inserts literal marker text into the message.
- With `--wait-submit 20`, the receipt reports `input_accepted`, then `turn_started`, for every multi-line case sent with `--enter` (full raw receipt for case A only). No one-line control with the same flags was captured, and the adapter's real mode (no `--wait-submit`) was not captured for multi-line text.
- The agent reply was seen in all cases, and `lastAssistantMessage` in `worktree ps` was checked for case F (the other cases were seen on the screen only), so the reply-text part of the `ORCA-PAUSED <token>` ack proof still works (inferred: no `ORCA-PAUSED` reply was captured, see Not tested).

**Recommendation: build it** (details at the end).

## Setup

```sh
orca-ide terminal send --help          # options: --text --enter --interrupt --wait-submit --retry-request --json
orca-ide terminal create --title "THROWAWAY-95" --json                           # plain shell, for the raw-byte test
orca-ide terminal create --title "THROWAWAY-95b" --command "claude --model sonnet" --json   # Claude Code, for the prompt tests
```

Raw `orca-ide terminal send --help`:

```text
orca terminal send

Usage: orca terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--wait-submit <seconds>] [--retry-request <id>] [--json]

Send input to a live terminal

Options:
  --help                 Show this help message
  --json                 Emit machine-readable JSON
  --pairing-code
  --environment
  --terminal <handle>  Runtime-issued terminal handle
  --text <text>          Text payload to send or type
  --enter                Append Enter after sending text
  --interrupt            Send as an interrupt-style input when supported
  --wait-submit
  --retry-request

Notes:
  For a text-plus-Enter agent prompt, the result separates input acceptance from observed submission and turn start.
  --wait-submit only observes the accepted prompt for the requested duration; timeout returns the queued/input-accepted receipt and never resends.
  After an ambiguous transport failure, reissue the exact command with the reported --retry-request ID. The ID is bound to the prompt payload and exact terminal process incarnation.
  Older hosts accept the legacy raw input but report provider old-host and do not offer idempotent retry or submission observation.
```

`terminal send` has no paste, bracketed-paste or multi-line option. Its relevant options are `--text`, `--enter`, `--interrupt`,
`--wait-submit <seconds>`, `--retry-request <id>`, `--json`.

## Q1. What does `--text` do with `\n` and `\r\n`?

### Raw bytes reach the terminal unchanged (plain shell)

The shell ran `stty raw -echo; cat -v`, so `cat -v` shows each byte as the terminal program received it.

```sh
orca-ide terminal send --terminal $H --text $'A1\nA2' --json          # bytesWritten: 5
orca-ide terminal send --terminal $H --text $'B1\r\nB2' --json        # bytesWritten: 6
orca-ide terminal read --terminal $H --screen --json
```

```text
"tail": [ ...
  "A1",
  "  A2B1^M",
  "        B2" ]
```

`A1\nA2` is 5 bytes and `B1\r\nB2` is 6 bytes: the CLI writes the text byte for byte. `\n` arrives as LF (a line feed),
and `\r\n` arrives as CR+LF (`^M` is the CR). The CLI does not convert or strip either one.

### Claude Code prompt: a newline is a line break, not a submit

Claude Code ran in the second throwaway terminal. Each message asked for a fixed word and a line count.

**A. LF, with `--enter`:**

```sh
orca-ide terminal send --terminal $H --text $'Test A. Reply with exactly: ACK-A and the count of lines in this message. Do not use tools.\nsecond line of test A\nthird line of test A' --enter --wait-submit 20 --json
```

Screen afterwards (`terminal read --screen`):

```text
❯ Test A. Reply with exactly: ACK-A and the count of lines in this message. Do not use tools.
  second line of test A
  third line of test A
● ACK-A
  The message has 3 lines.
```

**B. CRLF (`\r\n`), with `--enter`:**

```sh
orca-ide terminal send --terminal $H --text $'Test B. Reply with exactly: ACK-B and the count of lines. No tools.\r\nsecond line of B\r\nthird line of B' --enter --wait-submit 20 --json
```

`bytesWritten: 115`. Result: `● ACK-B` / `The message has 3 lines.`
Claude Code saw one 3-line message. CRLF behaves like LF.

**C. Structure (blank line, numbered list, indent, a line starting with `/`, a line starting with `!`):** `bytesWritten: 188`.

```sh
orca-ide terminal send --terminal $H --text $'Test C. Reply with exactly: ACK-C and the count of lines including blank ones. No tools.\n\n1. first step\n   - indented sub step\n/not-a-command line\n! not-bash line\n2. last step' --enter --wait-submit 20 --json
```

Result: `● ACK-C` / `The message has 7 lines, including 1 blank line.` All 7 lines arrived in one message. The `/` and `!`
lines were not run as a slash command or a shell escape; the agent counted them as message text. A leading `/` or `!` on the first line was not tested.
The `terminal read --screen` rendering indented some of these lines unevenly; this is probably a display artifact of the read (inference; the same applies to the missing blank line in case E), and
the agent's line count is the evidence that the text was intact.

**F. Long message (60 numbered lines, `bytesWritten: 2969`):**

```sh
T="Test F. Reply with exactly: ACK-F and the number of the last numbered line. No tools."
for i in $(seq 1 60); do T+=$'\n'"line $i: lorem ipsum dolor sit amet consectetur"; done
orca-ide terminal send --terminal $H --text "$T" --enter --wait-submit 20 --json
```

Result: `● ACK-F` / `The last numbered line is 60.`
Claude Code folds long input into a pasted block (the `prompt` field of `worktree ps` starts with `<pasted_content id=...>`),
but the agent still read all 60 lines.

Conclusion for Q1: `\n` and `\r\n` are both typed as line breaks inside the prompt. Neither one submits early.

### Trailing newline

```sh
orca-ide terminal send --terminal $H --text $'Test D. Reply with exactly: ACK-D and the count of lines. No tools.\nsecond line of D\n' --json      # no --enter; bytesWritten: 85
orca-ide terminal send --terminal $H --enter --json                                                   # bytesWritten: 1
```

After the first call the screen showed no reply and the receipt, filtered with `jq -c '{b:.result.send.bytesWritten,st:.result.send.prompt.stages,w:.result.warnings}'`, was `{"b":85,"st":null,"w":null}` (the full raw receipt was not kept; the first screen read after it showed no reply). After the second call: `● ACK-D` / `The message has 2 lines.`
A trailing `\n` is a line break, not a submit; only `--enter` submits. The agent counted 2 lines, so it did not count the trailing `\n` as a third line (inference from the agent's count).

## Q2. Does bracketed paste, or another option, keep the lines together?

Not needed: Q1 shows that plain `\n` already keeps the lines together. No option exists for it (see Setup).

Hand-written bracketed-paste markers do **not** work as markers: Claude Code inserts them into the message as literal text (the agent still answered):

```sh
orca-ide terminal send --terminal $H --text $'\e[200~Test E. Reply with exactly: ACK-E and the count of lines. No tools.\nsecond line of E\n\nfourth line of E\e[201~' --enter --wait-submit 20 --json
```

```text
❯ <ESC>[200~Test E. Reply with exactly: ACK-E and the count of lines. No tools.
  second line of E
  fourth line of E<ESC>[201~
● ACK-E
  The message has 4 lines.
```

The markers (`ESC[200~` and `ESC[201~`) end up inside the message text. Do not add them. (The same markers sent to the plain
shell test were echoed as `^[[200~` and `^[[201~`; the command was `--text $'\e[200~P1\nP2\e[201~'`, 17 bytes written.)

Other options: `--interrupt` is not a text option (the help says it sends "interrupt-style input"; in the shell test it wrote 1 byte, shown as `^C`).

## Q3. What does the send receipt report?

For every Claude Code case above (A, B, C, E, F) the `--json` receipt had the shape below (no one-line control was captured with `--wait-submit 20`).
Fields kept, ids redacted; this sample is case A:

```json
{ "ok": true,
  "result": {
    "send": { "handle": "$H", "accepted": true, "bytesWritten": 147,
      "prompt": { "requestId": "<uuid>", "stages": ["input_accepted", "turn_started"],
                  "provider": "claude", "observation": "supported", "processIncarnation": "<uuid>", "generation": 109 } },
    "mutation": { "requestId": "<uuid>", "replayed": false } } }
```

- For B, C, E and F only the output of `jq -c '{b:.result.send.bytesWritten,st:.result.send.prompt.stages,w:.result.warnings}'` was kept, for example `{"b":115,"st":["input_accepted","turn_started"],"w":null}` (case B). The full raw JSON is shown for case A only.
- `stages` was `["input_accepted","turn_started"]` in all five cases, with `--wait-submit 20`. There was no `warnings` field.
- `bytesWritten` is larger than the text length. Text length was recounted with `printf '%s' <text> | wc -c`:

  | Case | Text bytes | `bytesWritten` | Difference | `stages` | `warnings` |
  |------|-----------|----------------|-----------|----------|-----------|
  | A (LF, `--enter`) | 134 | 147 | +13 | `input_accepted`, `turn_started` | none |
  | B (CRLF, `--enter`) | 102 | 115 | +13 | same | none |
  | C (structure, `--enter`) | 175 | 188 | +13 | same | none |
  | E (hand-made markers, `--enter`) | 114 | 135 | +21 | same | none |
  | F (60 lines, `--enter`) | 2956 | 2969 | +13 | same | none |
  | D (trailing LF, no `--enter`) | 85 | 85 | 0 | `stages: null` (jq filter above) | `null` |

  The shell tests also wrote exactly the text length (5 and 6 bytes, and 17 bytes for the marker text). With `--enter` to Claude Code
  the CLI wrote 13 bytes more than the text, a constant that does not depend on the text length. We did not capture the extra bytes.
  The `--enter` itself is one byte. The other 12 are consistent with Orca wrapping the text in its own bracketed-paste markers
  (`ESC[200~` and `ESC[201~`, 6 bytes each), but that is an inference. The extra bytes appear only on the `--enter` path (evidence: the single case D, without `--enter`, wrote none; the markers of case E are already counted in its 114 text bytes). The plain-shell receipt wrote 23 bytes for a 22-byte text, so there `--enter` added exactly 1 byte and no wrapping. The recommendation does not depend on this inference. Case F, which Claude Code folded into a pasted block, is consistent with it. Case E has 8 more unexplained bytes (+21 instead of +13), so the inference stays open. The adapter must not add markers. A
  one-line control was not captured, so we do not know whether one-line text gets the same extra bytes.
- Without `--enter` (the trailing-newline test) the filtered receipt showed `stages: null` and `warnings: null`, so no submission stage was reported. For the other cases the receipt names only the stages `input_accepted` and `turn_started`; no separate "submitted" stage appeared.
- Plain shell (command: `orca-ide terminal send --terminal $H --text "stty raw -echo; cat -v" --enter --json`), raw receipt fields:

  ```json
  "send": { "accepted": true, "bytesWritten": 23,
    "prompt": { "stages": ["input_accepted"], "provider": "unsupported", "observation": "unsupported" } },
  "warnings": ["input was accepted, but this provider cannot report delivery. Inspect the terminal before retrying."]
  ```
- The adapter (`src/orca-adapter.ts`, `send`) does not pass `--wait-submit`. Without it, the existing fixture
  `test/fixtures/terminal-send-accepted.json` shows only `input_accepted` and a "no turn start was observed" warning. That
  is the existing one-line behaviour. Multi-line text was not sent without `--wait-submit`, so its receipt in that mode was not captured.

## Q4. Do the agent reply and `lastAssistantMessage` still work for the ack proof?

```sh
orca-ide worktree ps --json > ps.json
jq -c '[.. | objects | select(.paneKey? != null and (.paneKey | startswith("<throwaway tabId>")))]' ps.json
```

Row after case F (redacted):

```json
{ "paneKey": "<tabId>:<leafId>", "state": "done", "agentType": "claude",
  "prompt": "<pasted_content id=\"...\"> Test F. Reply with exactly: ACK-F and the number of the last numbered line. No tools. line 1: lorem ipsum dolor sit amet consectetur line 2: lorem ipsum dolor sit amet conse",
  "lastAssistantMessage": "ACK-F\n\nThe last numbered line is 60.",
  "interrupted": false }
```

- `lastAssistantMessage` holds the agent reply of the multi-line message, including its own `\n`.
- `prompt` is a flattened, truncated copy of the message (newlines became spaces, and long input is wrapped in
  `<pasted_content id=...>`). Do not use `prompt` for the proof. This matches the rule in `AGENTS.md`: the proof comes from
  the agent state and its last reply.
- The agent also answered with its fixed word in every case (`ACK-A` to `ACK-F`, read from the screen for A to E; the row above is for F only). Inference: a `ORCA-PAUSED <token>` reply is
  possible for multi-line text in the same way as for one line.

## Not tested

- A send while the agent is mid-turn (queued input). One-line text has the same question.
- Providers other than Claude Code (the receipt says `unsupported` for a plain shell).
- Windows hosts (all tests ran on Linux).
- A multi-line reply that carries an `ORCA-PAUSED <token>` line; only `ACK-x` replies were captured.
- Text whose first line starts with `/` or `!`. Nothing in `src/` validates this today (`src/broadcast.ts` does not check a leading `/` or `!`).
- A tab character.
- A one-line send with the same flags (`--wait-submit 20`), and a multi-line send without `--wait-submit` (the adapter's real mode). Both gaps limit the receipt claim in Q3.

## Recommendation: build it

Build multi-line broadcast. The transport already supports it with no new option.

1. Allow newlines in the text read from `--file` (`--file` already exists). Normalise `\r\n` to `\n` first, so one form is sent. Note: `normaliseText` in `src/broadcast.ts` trims the text, so a trailing newline is dropped silently. The broadcast also wraps the text in a longer prompt that ends with the ack line; a multi-line text inside that wrapper was not tested. The length limit (`MAX_TEXT_LENGTH`) may also need a decision, since case F (about 2.9 KB) would be refused today by the 1000-character limit. These are build-ticket details.
2. Send it unchanged with the existing `terminal send --text <text> --enter`. Do not add bracketed-paste markers.
3. Keep refusing the other control characters (ESC, `^C` and so on): ESC is what would open a paste-marker or escape-sequence
   path. After normalising, allow only `\n`; a lone `\r` was not tested and stays refused. Tab was not tested; decide about it separately.
4. Keep the ack proof as it is. Use `lastAssistantMessage` and the `ORCA-PAUSED <token>` reply, never the receipt, and never `prompt`.

Cost: small. The change is in the validation of the text (allow `\n`), the `--file` reader, and tests with a fake port that
check the exact `--text` value. Risks: (a) ESC and the other control characters must stay refused, and tab needs its own test; (b) a first line that
starts with `/` or `!` was not tested and is not validated today (the same holds for one-line text);
(c) the mid-turn case above is untested. The alternative, keeping one-line text, costs nothing but forces checklists into one line.

Note on the same option, not a second option: the build ticket may also pass `--wait-submit <seconds>` so the receipt reports `turn_started`.
