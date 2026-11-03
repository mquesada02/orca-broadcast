# How to restart an agent that did not come back (research for #123)

Research for issue #123 (map #120). Captured 2026-10-12 on Linux. Claude Code v2.1.296, Orca (`orca-ide`) 1.4.223.
No `src/` or test change. Every command below was read-only: `--help`, `skills get`, read-only listings, and reads of files on disk.
No terminal was created, written to, read or waited on. No Claude Code session was started. `orca-broadcast` was not run.

Redaction: ids (session ids, pane keys, handles, dispatch ids), paths and user names are placeholders. No message content was read or is quoted.

## Answer in short

1. **Best option (only for an agent proven gone, with the checks in Recommendation): a new terminal in the agent's own worktree that runs `claude --resume <session id>`.** The exact command:
   `orca-ide terminal create --worktree path:<worktree path> --title <title> --command "claude --resume <session id>" --json`.
   It needs the session id and the worktree path (plus a launch flag such as `--permission-mode bypassPermissions` if the agent used `bypassPermissions`; see Recommendation). The conversation, the model and the permission mode come back from the transcript, with exceptions listed in the docs (for example `bypassPermissions` does not come back). Eight live Claude processes on this machine run the same `claude --resume <uuid>` form; they are apparently Orca's restored panes (inference, see Q1). The create step was **not run live** (untested; see Not tested).
2. **By default a resumed session is expected to wait for a prompt (not tested).** The docs say an interrupted tool call is not run again and that background-work notes start no turn. They also document an opt-in: with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` a session that ended mid-turn "automatically" continues on resume (env-vars page; the row says "Used in SDK mode", so it may not apply to interactive panes). `--resume` loads the history. A tool call that was running when the process ended is not run again (docs, quoted under Q1). The tool must send a prompt if it wants the agent to continue.
3. **No Orca command found in `--help` restores an agent with its old conversation.** `terminal create --command`, `worktree create --agent` and `worker-start --agent` start a new process. `dispatch --inject` and `worker-start --terminal` reuse an existing terminal (untested). None of them restores the old conversation by itself; only `claude --resume` does. The simpler alternative, a fresh `claude` plus a prompt, is cheaper to build but loses the history. `worktree create` makes a new checkout, so it is wrong for a restart.
4. **A restart outside orchestration: dispatch, run and coordinator view (all untested).** Per the Orca orchestration help the dispatch is bound to its assignee handle and terminal, and `worker_done` is accepted only from the dispatched pane or a matching handle. So the verdicts are: dispatch not changed by the restart but may be unusable from the new pane (unknown until tested); run not affected (no source says otherwise; inference); coordinator view stale and not repaired (inference). The new terminal is expected to get a new handle and pane key. The tool should not call any orchestration command that changes state. The coordinator decides (`worker-start --retry-of`, or accept the resumed agent).
5. **Do not resume a session that may still be alive.** Docs: messages from two terminals on one session interleave into one transcript. The tool must check that no live Claude process holds the session id before it resumes.

**Recommendation:** use option A below, only for an agent whose process is proven gone, and report workers with an open dispatch to the user instead of repairing the dispatch. Details under Recommendation.

## Method

```sh
claude --help ; claude --version
orca-ide status --json
orca-ide terminal --help ; orca-ide terminal create --help ; orca-ide terminal list --help
orca-ide worktree --help ; orca-ide worktree create --help ; orca-ide worktree ps --help
orca-ide orchestration --help
orca-ide orchestration {worker-start,dispatch,worker-show,worker-stop,worker-abandon,worker-release,worker-retain,worker-read,worker-list,send,check,request-show,task-create} --help
orca-ide skills get orchestration
orca-ide skills get orchestration --reference references/recovery-and-cleanup.md
orca-ide skills get orchestration --reference references/low-level-topology.md
orca-ide terminal list --json          # shape only
orca-ide worktree ps --json            # shape only
orca-ide orchestration worker-list --json   # shape and counts only
ps -eo args=                           # claude command lines only, ids redacted
```

Files read on disk (field names and counts only): `~/.claude/sessions/*.json` (and, for context, Orca's `agent-hooks/last-status.json`; its findings belong to #121/#122 and are not reported here).
Docs fetched (first-party): <https://code.claude.com/docs/en/cli-reference>, <https://code.claude.com/docs/en/sessions> and <https://code.claude.com/docs/en/env-vars>.

## Q1. Option A: `claude --resume <session id>` in a new terminal

### The command and what it needs

```sh
orca-ide terminal create --worktree path:<worktree path> --title "<title>" --command "claude --resume <session id>" --json
```

| Need | Source | Evidence |
| --- | --- | --- |
| Session id | Not in the Orca listings; the transcript file name is the id (Q4). The source is decided in #121/#122. | Q4 |
| Worktree | `--worktree path:<path>` (or `id:`, `branch:`, `name:`) | `terminal create --help` below |
| Model | Not needed. The resumed session keeps its model (the docs list exceptions under "Setting your model"). | Docs quote below |
| Permission mode | Restored with exceptions: `bypassPermissions` is not restored (the session starts in the mode a new session would start in: the settings `defaultMode` or the built-in default), and `auto` is restored only if the account still qualifies. Pass a launch flag (`--permission-mode ...` or `--dangerously-skip-permissions`) to set it. | Docs quote below |

`terminal create --help` (trimmed to the relevant lines):

```text
Usage: orca terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--shell <shell>] [--focus] [--json]

Create a terminal session in the current worktree
  --worktree <selector>  Worktree selector such as identity:<identity>, id:<repo-id>::<path>, name:<displayName>, branch:<branch>, issue:<number>, path:<path>, or active/current
  --command <text>       Command to run in the terminal on startup
Notes:
  Creates a visible terminal tab without switching focus when possible; falls back to a background handle if the UI cannot adopt it. Pass --focus to switch to it.
  Use this, not worktree create, for a fresh agent in the current checkout.
```

The default worktree is the **current** one (the caller's). The tool must always pass `--worktree`, or the agent lands in the tool's own worktree.

### What the user sees

A new terminal tab in the agent's worktree, without a focus switch (help text above). Claude Code starts and loads the conversation. This was not observed live (untested).

### Eight live panes run this form (probably Orca's restore; inference)

`ps -eo args=` on this machine, filtered to Claude processes, with ids redacted:

```text
     15 claude --model sonnet
      8 claude --resume <uuid>
      6 claude --model claude-sonnet-5-5
      2 claude --model claude-opus-5-5 --permission-mode auto --effort medium
      1 claude -r
      1 claude --model claude-sonnet-5-5 --permission-mode auto --effort medium
```

Eight live Claude processes run `claude --resume <uuid>`. They are apparently sessions that Orca restored after the restart of 2026-10-12, which the map (#120) describes. This is an inference: `ps` shows the command line, not who started it. The command line is evidence that the form runs here. The `ps` list shows 33 Claude command lines but `~/.claude/sessions` holds 32 `*.json` files; the extra line may be a non-session invocation (such as `claude -r`, the picker form). Not checked.
The `terminal create --command "claude --model sonnet"` form was used live in `docs/research/multiline-send.md` (Setup section), so `--command` is known to start Claude Code in a new terminal.

### What `--resume` does (first-party docs)

From <https://code.claude.com/docs/en/cli-reference> (flag `--resume`):

> Resume a specific session by ID or name, or show an interactive picker to choose a session. [...] When you pass a session ID, Claude Code searches the current project directory and its git worktrees, then every other project on this machine.

From <https://code.claude.com/docs/en/sessions> ("Resume by session ID or name"):

> You can run `claude --resume <session-id>` from any directory [...] The cross-project search resolves the ID only when exactly one other project holds a transcript with messages for it, so a hand-copied duplicate makes Claude Code report not-found rather than resume an arbitrary copy. If no stored session matches the ID, Claude Code reports `No conversation found with session ID: <session-id>`.

So the id resolves from any directory, but the tool should still start the terminal in the agent's own worktree, because that is where the agent works (its cwd, branch and files).

From "What a resumed session restores":

> Conversation history [...] A tool that was still running when the previous process ended, for example in a crash, doesn't finish or run again when you resume. Claude sees the call marked as cut off before its result was recorded and is told to check whether it took effect before running it again, unless `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` is set.
> Model: the session continues on the model it was using [...]
> Permission mode: [...] Claude Code restores the permission mode the session was in, except in the cases in [...].

and the table row: `bypassPermissions` | Terminal | "The permission mode a new session would start in [...]"

> Not every configuration flag from the original launch is restored. If the session depended on `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, or directories added with `--add-dir`, pass them again when you resume [...]

Consequences for the tool:

- By default the resumed session is expected not to continue its turn by itself: the interrupted tool call does not run again, and for background-work notes the docs say Claude Code "doesn't start a turn from those notes". The docs also document an opt-in (the variable is described as "Used in SDK mode", so it may not apply to interactive panes), from <https://code.claude.com/docs/en/env-vars>: `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` "Set to `1` to automatically resume if the previous session ended mid-turn." and `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS` bounds it ("the session starts idle so you continue explicitly" when the last message is older than the bound). Neither was tested. **Risk:** if either variable is set in Orca's environment, a resumed agent may continue on its own, and a prompt-based proof (a changed reply) becomes ambiguous. The variables' presence in Orca's environment was not checked. The tool must send a prompt (for example the pause or broadcast text) to get a reply. What `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` does exactly was not tested.
- An agent that ran with `bypassPermissions` comes back in the mode a new session would start in (settings `defaultMode` or the built-in default). To restore bypass, the docs name a launch flag or `permissions.defaultMode: "bypassPermissions"` in user, `--settings` or managed settings. The tool would need to pass the flag again; the old mode is not in the Orca listings, so this needs the user's decision in the spec.
- Background Bash and monitor tasks are not restored (docs: "Background Bash and monitor tasks aren't"). An agent that waited on a background shell loses it.

### A session that is still running

From the sessions page ("Branch a session"):

> If you resume the same session in two terminals without forking, messages from both interleave into one transcript.

So `--resume` of a live interactive session makes two writers interleave into one transcript (docs). For a background session that is still running, the docs say `--resume` opens (attaches to) that session instead; no live session here looks like a background one (all 32 are `kind: interactive`). The tool needs a liveness check before it resumes. Redacted field names of `~/.claude/sessions/<pid>.json` (one file per live process; 32 `*.json` files, all `kind: interactive`, `entrypoint: cli`):

```text
pid sessionId cwd startedAt procStart version peerProtocol peerFeatures kind entrypoint
pidDomain messagingSocketPath name nameSource nameSince updatedAt status statusUpdatedAt
(a subset: some files also carry other fields, such as waitingFor)
```

All 32 `pid` values existed in `/proc` at capture, so no stale file was seen. A liveness check would need `pid` and `procStart` (inferred from the field names, not tested). How to find and match agents is the subject of #121 and #122.

### `claude respawn` and `claude attach`

`claude respawn <id>` ("Restart a background session, running or stopped, with its conversation intact") and `claude attach` apply only to **background sessions** (`claude --bg`, agent view). All 32 live sessions here are `kind: interactive`, so these commands do not apply. They are noted only because the name suggests a fit.

## Q2. Options in Orca

### Overview of the options

| Option | Exact command | Needs (session id / worktree / model) | What the user sees | Restores the conversation? |
| --- | --- | --- | --- | --- |
| A | `orca-ide terminal create --worktree path:<wt> --title <t> --command "claude --resume <id>" --json` | session id; worktree; model kept by the session | New terminal tab in that worktree, no focus switch (help text); untested live | Yes (docs) |
| B | `orca-ide worktree create --name <n> --agent claude --prompt <text> --json` | worktree is created new; no session id option in the help; `--base-branch`; `--model` is not a `worktree create` option | New worktree and a first terminal with a fresh agent (help text); untested | No |
| C | `orca-ide terminal create --worktree path:<wt> --command "claude"` | worktree; `--model` goes in the command | New terminal with an empty conversation; untested | No |
| D | `orca-ide orchestration worker-start --task <T> --retry-of <D> --worktree <sel> --agent claude --json` (or `--terminal <handle>` in place of `--agent`) | failed task id and dispatch id; agent or terminal; placement (`--worktree` or `--on`); `--model` optional (not with `--terminal`) | A new supervised worker; the coordinator is expected to see a new dispatch (inference); untested | No (only if `--terminal` holds a resumed session) |
| E | `orca-ide orchestration dispatch --task <T> --to <handle> --inject` | task id; a live terminal handle | Task prompt injected into an existing terminal; unsupervised; untested | No |
| F (rejected for the tool, see below) | `orca-ide terminal send --terminal <handle> --text "claude --resume <id>" --enter` into a surviving shell-only pane | a terminal handle (goes stale); session id | The command typed into that pane; untested | Yes, if the pane really is an idle shell |
| G | `claude --continue` / `claude -r` (picker) in a terminal | worktree as cwd; no id for `--continue` | The latest session of that directory / a picker; untested | Yes, but `--continue` picks "the most recent conversation in the current directory", which may not be the agent's |

Option F is the likely case after a crash (#120: "panes with only a shell"), but it types into a live terminal. It needs a handle (stale across restarts, per AGENTS.md) and the same liveness proof as A. `terminal create` (A) is safer: it does not depend on the old pane. F is rejected for the tool. Not run, because `terminal send` is forbidden here.

`orca-ide search` ("Search the full text of agent sessions indexed on the selected Orca host", `--agent`, `--path`, `--since`) could find a session by text. Its help does not say that hits carry a session id; not tested. It searches message text, so using it to find an id has a privacy cost. Reading the transcript file names (Q4) avoids reading message text.

### `orca-ide worktree create --agent claude --prompt <text>`

Creates a **new checkout** ("This creates a new checkout. For a fresh agent in an existing worktree, use `orca terminal create --worktree active --command "codex"` instead."). `--agent` "Launch a known TUI agent in the first terminal". The help has no resume option. Not suitable: the agent must return to its own worktree, with its old conversation.

### `orca-ide terminal create` (without `--command`)

`terminal create` without `--command` gives a plain shell. `terminal create --command "claude"` gives a fresh session with an empty conversation. Only the `--command "claude --resume <id>"` form (Q1) brings the conversation back. `--command` is "typed into" the shell that the host starts (`terminal create --help`, Windows note), so `claude` must be on that shell's PATH (inference). `terminal split` (listed in `terminal --help`) was not read further; it adds a pane, not a restart.

### `orca-ide orchestration worker-start --task <T> --retry-of <D> --worktree <sel> (--agent claude | --terminal <handle>)`

Usage line (trimmed): `worker-start (--task <task_id> | --spec <text>) [--worktree ...] (--agent <agent> | --terminal <handle>) [--model <id>] [--retry-of <dispatch_id>] ...`

- **Needs (model):** `--model` is a "Provider model id for a new agent launch", and the help notes "Neither can combine with --terminal" (for `--model` and `--effort`); a resumed session keeps its own model. **Other needs:** the failed Task id (`--task`), the failed dispatch id (`--retry-of`), a placement and an agent or terminal. Help: "`--retry-of` needs `--task` naming the failed Task (`--spec` creates a new one) and does not inherit placement; repeat the intended `--on`/worktree and `--agent`/terminal choices."
- **When allowed:** "Retry only a positively proven failed or stopped attempt." (recovery reference). After three consecutive failures of one Task, its context circuit-breaks.
- **What it does to the conversation:** `--agent` starts a fresh agent; the help names no resume. `--terminal <handle>` reuses an existing terminal ("a fresh agent terminal is created unless --terminal is explicit"; "When reusing --terminal, pass --worktree for that terminal"). So a terminal that already runs `claude --resume <id>` could be adopted, and the Task spec is then injected as a prompt. This combination was not tested.
- **What it does to the dispatch:** it is expected to create a new dispatch (inference; the help does not describe it). The old dispatch stays failed or stopped.
- **Who may call it:** the help names no caller restriction (`--run` and `--from` exist, with no description). It is a state-changing command, so the tool must not call it.

### `orca-ide orchestration dispatch --task <T> --to <handle> --inject`

Low-level reference: "`dispatch --inject` creates authoritative Task/Dispatch context but deliberately keeps an operator-created process unsupervised: it creates no supervised worker resource row [...] Never imply that low-level dispatch retroactively owns a process." Not a restart option. State-changing.

### `worker-stop`, `worker-abandon`, `worker-release`, `worker-retain`

These settle or fence dispatches and release terminals. They do not restart anything. The recovery reference says `worker-stop` "closes only the exact proven supervised agent terminal". Help for `worker-abandon`: "Retains all possibly-live resources and performs no process or filesystem action." All state-changing: out of reach for the tool.

## Q3. What a restart outside orchestration does to an Orca worker

Facts from `orca-ide skills get orchestration`, its recovery reference and `--help` (quoted; the `unverifiable` quote is from the recovery reference):

- "Lifecycle authority comes from the active Dispatch, not a terminal title, copied ID, old database row, provider transcript, or visible pane."
- "A `worker_done` with the active task/dispatch IDs completes that task only from the dispatched pane. When stable pane identity is unavailable, the sender handle must exactly match the dispatch assignee; injected preambles include the correct `--from` value." (`orchestration send --help`)
- "Liveness is layered: `worker-list`'s `projection.liveness` is the fleet verdict for the agent; `worker-show`'s `observation.status` is PTY liveness only. A live terminal can still hold a dead or stuck agent."
- `unverifiable` "is always absence", and "Absence never authorizes stop, abandon, retry, or release" (recovery reference; the second sentence is also in the main skill text).

What this means for a worker whose pane was replaced (inference from the quotes; not tested):

| Part | Effect of a restart outside orchestration |
| --- | --- |
| Dispatch | (Inference) Not changed by the restart, but may be unusable from the new pane (see Worker commands). It keeps its old assignee handle and `agentTerminalHandle`. |
| Run and coordinator inbox | (Inference, weak: no source says otherwise) Run not affected. The coordinator keeps its view of the old dispatch: stale and not repaired. |
| Worker commands | The resumed conversation still contains the old preamble with the old `--from <old handle>`. A `worker_done` or heartbeat sent from the new pane may be treated as coming from a handle that does not match the assignee. Whether Orca accepts it by stable pane identity was not tested. |
| Coordinator view | `worker-list` row stays as before. The `counts` object (772 released, 437 retained, 27 reclaimable, 24 release_unknown, 12 active) covers all rows. The row shape below was read from the first page only (100 rows of 1272; `hasMore: true`). At capture time and on that page only (counts drift between runs), the verdicts were unverifiable 57, exited 26, live 17; the reasons were `missing_status` 53 and `stale_status` 4; `nextAction.kind` was none 95, release 4, inspect 1 at capture time (it changes between runs). The recovery reference also names `restored_unconfirmed`, not seen in this page. (Inference) A restarted agent in a new terminal is not tied to such a row. |

Real `worker-list` row shape (field names only; one row; all values are placeholders):

```text
dispatchId taskId runId workerState dispatchStatus agentTerminalHandle terminalState
resource.{id ownershipState releaseState retainedReason terminalHandle worktreeId endpointId endpointIncarnation originDispatchId ownerDispatchId ...}
projection.{id dispatchId taskId runId role parent provider.{id model} host.{kind id} workspace.{id kind}
  stage.{worker dispatch detail activity} outcome liveness.{verdict observedAt source}
  evidence.{durable liveStatus lastObservedAt} resource.state nextAction.{kind argv} attention.{categories requiresAction}}
```

The hand-over of this stale dispatch to a coordinator is the coordinator's call. The row holds `agentTerminalHandle`, a **handle**. AGENTS.md says handles go stale and nothing may be keyed on them. So the dispatch row is not a stable key for finding the restored pane (finding it is #121/#122).

Recommended boundary: the tool restarts the pane. The coordinator (or the user) decides what to do with the dispatch: `worker-start --task <T> --retry-of <D> ...` for a failed attempt, or leave the resumed worker. The tool only reports that the agent had an open dispatch.

## Q4. Where the session id comes from (needed by option A)

Option A needs a session id. The Orca listings read here do not carry one: `worktree ps --json` agent rows (`paneKey parentPaneKey state agentType prompt taskTitle displayName lastAssistantMessage toolName toolInput interrupted mainAgent stateStartedAt updatedAt`) and `terminal list --json` rows (`handle ptyId incarnationId orphaned worktreeId worktreePath branch tabId leafId title connected writable lastOutputAt preview executionHostId agentIdentity`) have no session id field. The transcript file name is the session id (`~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>/<session id>.jsonl`; docs, "Where transcripts are stored"). Where the tool reads the id from, and how it matches an agent to it, is decided in #121 and #122.

## Not tested

- Any live restart: `terminal create --command "claude --resume <id>"` was not run. Reason: the map forbids starting a Claude Code session (and records such a test as untested).
- What a restored pane shows, and whether the tool can see the agent as `working`/`done` again after the resume.
- Whether a `worker_done` or heartbeat from a replaced pane is accepted, and how `worker-list` shows it.
- `worker-start --terminal <resumed terminal> --retry-of ...`.
- `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`.
- Whether `--resume` finds a session whose worktree was removed (docs: it resumes "in your current directory" for a session picked from the picker; for the id form the docs name only the lookup order).
- Orca's own restore mechanism: the 8 `claude --resume <uuid>` processes show the command line, not the code path that started them.

## Recommendation

1. **Restart with option A**, per agent, only after three checks pass: the session id is known, no live process holds that id (`~/.claude/sessions/*.json` plus a liveness check on `pid`), and the transcript file exists.
2. **Always pass `--worktree path:<the agent's worktree path>`**, and pass a launch flag (`--permission-mode bypassPermissions` or `--dangerously-skip-permissions`) explicitly for an agent that used `bypassPermissions` (decision for the spec: restart in the mode a new session would use, or ask).
3. **After the resume, send a prompt** (a resumed agent is expected to be idle per the docs; untested) and prove the reply from Orca state, as AGENTS.md requires. Check that `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` is not set (see Q1).
4. **Do not touch orchestration state.** For workers with an open dispatch, restart the pane only if the user confirms, and tell the user that the dispatch still points at the old handle. Leave `worker-start --retry-of` to the coordinator.
5. Do not use `worktree create` for a restart.

Risks:

- **Duplicate session** if the liveness check is wrong: messages from two writers interleave in one transcript (docs).
- **Stale session id** from whatever source the tool uses: `No conversation found with session ID` (docs). The tool must report it as "could not restart", not retry.
- **Lost background work and `bypassPermissions`** (docs; see Q1).
- **Dispatch drift** for workers (Q3, inference).
- **Wrong-pane risk:** `terminal create` defaults to the caller's worktree. A missing `--worktree` starts the agent in the wrong place.
