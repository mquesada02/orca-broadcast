# What the four commands save to their records while they wait

Snapshot of 2026-11-11, from the source at `main` (f63bd37). Nothing was run against Orca and no state folder was read. Paths are relative to the repo root. Question: ticket #262, map #261.

## Short answer

| Command | Record file | Saved during the wait | Open run found by | Process-gone mark |
|---|---|---|---|---|
| `broadcast` | `broadcasts/<id>.json` | Every poll (2 s) | `peekOpen` (and `current`) | `pid` and `startTime` in the record |
| `recover` (crash) | `recoveries/<id>.json` | Every row start, every send, every tick | `peekOpen` (and `current`) | `pid` and `startTime` in the record |
| `recover` (of a pause run) | `pauses/<runId>.json`, field `recovery` | Same moments as crash mode | The open pause run | None in the record; the lock only |
| `pause` | `pauses/<runId>.json` | Start, before each send, every poll | The open pause run | None in the record; the lock only |
| `resume` | The same `pauses/<runId>.json` | Only before a send and at each proof poll | The open pause run | None in the record; the lock only |

No command stores a `label` field. `resume` can leave the record stale during a wait (see "Stale-data risks").

## Store layout and the open-run lookup

- The state folder holds `pauses/`, `broadcasts/`, `recoveries/`, `roster/`, the `current` pointer, `lock` and `lock.takeover` (`src/store.ts:9-15`). One file per record, `<id>.json` (`src/store.ts:150-153`).
- Every save writes a temporary file and renames it (`src/store.ts:140-144`), so a reader never sees a half-written record.
- A record is open when its `status` is `'open'` (`src/store.ts:226`). `peekOpen` scans the three folders for the newest open record of each kind. It needs no lock (`src/store.ts:63-64`, `330-337`).
- `loadOpen` is the same selection plus repairs. The caller must hold the lock (`src/store.ts:61-62`, `339-381`). It abandons a broadcast or a recovery that is open beside a pause run (`src/store.ts:346-363`) and rewrites the pointer (`src/store.ts:374-379`).
- Winner order: a pause run, then the newer of recovery and broadcast, a tie to the recovery (`src/store.ts:368-373`). Other open records of one kind are only reported (`src/store.ts:342-345`).
- `current` is JSON `{kind, id}` with `kind` `pause`, `broadcast` or `recovery` (`src/store.ts:26-29`, `303-306`). Anything that is not pointer JSON reads as missing (`src/store.ts:308-323`). It is a hint: only `loadOpen` repairs a wrong pointer, so a reader should use `peekOpen`.
- Each command sets the pointer after its first save: broadcast `src/broadcast.ts:168-170`, pause `src/pause.ts:318-319`, crash recovery `src/recover.ts:341-344`. The pointer is cleared only when the record closes: `src/broadcast.ts:291`, `src/resume.ts:152`, `src/recover.ts:355`. `clearCurrent` clears only a pointer that names that record (`src/store.ts:325-328`).
- Every command holds `lock` for its whole run (`src/guard.ts:98-111`, `src/cli.ts:242`). The file holds `<pid> <startTime>` (`src/store.ts:407-411`). A reader gets the owner with `lockOwner()` and needs no lock (`src/store.ts:66-67`, `402-405`).

## Per-target fields

| Wanted field | Pause run agent (`AgentRecord`) | Broadcast target (`BroadcastTarget`) | Recovery row (`RecoveryRow`) |
|---|---|---|---|
| status | `pauseStatus`, `resumeStatus` (`src/types.ts:215`, `223`) | `status` (`src/types.ts:491`) | `status` (`src/types.ts:339`) |
| reason | `pauseReason`, `resumeReason` (`src/types.ts:216`, `224`) | `reason` (`src/types.ts:492`) | `reason` (`src/types.ts:340`) |
| repo, worktree | `repo`, `repoId`, `worktree`, `worktreeId`, `worktreePath` (`src/types.ts:206-211`) | The same five (`src/types.ts:477-482`) | The same five, from `RosterEntry` (`src/types.ts:115-119`, `338`) |
| role | `role` (`src/types.ts:212`) | `role` (`src/types.ts:483`) | `role` (`src/types.ts:120`) |
| terminal | `lastHandle` (`src/types.ts:214`) | `lastHandle`, informational only (`src/types.ts:485-486`) | None: `paneKey` and `sessionId` only, no handle |
| label | None | None | `title`, the saved tab title, optional (`src/types.ts:133`) |

Notes:

- A pause agent and a broadcast target are keyed by `paneKey`. A recovery row is keyed by `sessionId` (`src/types.ts:113-114`). The terminal handle is rebuilt at each use from a fresh listing, which is why it is "informational only".
- Recover builds a tab label when it starts an agent: the saved `title`, else `<repo>/<worktree> (recovered)` (`src/recover-start.ts:102-103`). The label is not written to the record.
- Other per-target fields are `sessionId`, `permission`, `orchestrationRunIds`, `messagePending`, `baseline`, `transcript` and, for recovery, `promptDue`, `startedAt`, `listDue` and `extraWorkers` (`src/types.ts:205-237`, `338-355`, `476-495`).

## State names: pending and done

### broadcast

- `BroadcastStatus` is `pending | acked | gone | abandoned` (`src/types.ts:466`). Pending is "not yet done"; every other value is done.
- The record closes when no target is pending (`src/broadcast.ts:272`, `src/shared.ts:300-303`). A pending target can carry a reason: `still-working`, `background`, `waiting-permission`, `no-ack`, `send-failed` (`src/types.ts:467`).
- `abandoned` with reason `paused` or `closed` is set by `abandonPending` when another command ends the wait (`src/store.ts:124-132`).

### recover

- `RecoverStatus` is `restored | restarted | acked | pending | gone | left-to-coordinator | no-coordinator | failed | abandoned` (`src/types.ts:280`).
- `pending` is the only status that is never final (`src/recover-record.ts:22-23`). `restored` and `restarted` are final only when no prompt is due (`src/recover-record.ts:19-21`). `no-coordinator` is final except for one case (`src/recover-record.ts:10-12`).
- A row that waits for its agent to appear is `pending` with reason `awaiting-start` (`src/recover-wait.ts:31`). A row that waits for the ack is `pending` with `promptDue` (`src/recover-wait.ts:34`).
- The crash record closes with `endedBy: 'done'` when every row is final (`src/recover-record.ts:28-37`). In pause-run mode no record closes; the rows live in `run.recovery.rows` (`src/types.ts:456-463`).

### pause

- Per agent, pending is `pauseStatus: 'unconfirmed'`. It starts that way (`src/pause.ts:121`). Done is `confirmed`, `pauseReason: 'send-failed'` or `resumeStatus: 'gone'` (`src/pause.ts:64-66`).
- The run stays `status: 'open'` when `pause` ends. Only `resume` closes it (`src/resume.ts:149-152`).

### resume

- `ResumeStatus` is `pending | resumed | gone | abandoned` (`src/types.ts:187`). Every agent starts as `pending` (`src/pause.ts:127`). `resume` acts on the `pending` agents (`src/resume.ts:125`).
- The run closes when no agent is `pending` (`src/resume.ts:149-152`).
- `pending` is both the state after `pause` and the state during `resume`, so the status alone cannot tell "paused, waiting for resume" from "resume is running". Only `continueSentAt` and `continueBaseline` (`src/types.ts:225-226`) show that a CONTINUE was sent, and the lock shows that a command is alive.

## When each record is saved

### broadcast

- First save before the wait, with all targets `pending` and the pid set (`src/broadcast.ts:167-168`). The wait saves the working copy at its start (`src/broadcast.ts:268`) and after every poll (`src/broadcast.ts:271-273`), then sleeps `POLL_INTERVAL_MS`, 2000 ms (`src/shared.ts:7`, `src/broadcast.ts:278`).
- At the end, or on any error or interrupt, it clears the pid and saves once more (`src/broadcast.ts:288-291`).
- A re-run of an open broadcast saves the new pid first (`src/broadcast.ts:187-189`).

### recover

- Crash mode: `begin` sets the pid, saves, then sets the pointer (`src/recover.ts:338-349`). `startAgents` saves after each row decision and after each start (`src/recover-start.ts:72`, `88`, `117`). `settle` saves before each send, after each send and at the end of each tick (`src/recover-wait.ts:122`, `151`, `154`). `finish` releases the record and clears the pointer if it closed (`src/recover.ts:351-356`). `onError` clears the pid and saves (`src/recover.ts:357-360`).
- Pause-run mode: the same `save` calls write the whole pause run, with `run.recovery` rebuilt each time (`src/recover-pause.ts:175-193`). A start and its row reach the disk in one write (`src/recover-pause.ts:175`).

### pause

- First save before any send, with every agent `unconfirmed` (`src/pause.ts:318`). Another save before each send (`src/pause.ts:502`) and after each poll (`src/pause.ts:367`). An error or an interrupt saves too (`src/pause.ts:376`). A "no" at the late confirm writes back the loaded run, or removes a new one (`src/pause.ts:350-354`).
- At the commit point it also abandons an open broadcast or recovery (`src/pause.ts:320-332`).

### resume

- Nothing is saved before the user's yes (`src/resume.ts:120`). The agent changes in `sendAll` are in memory. A save happens only before each send (`src/resume.ts:194`), at each `awaitProof` poll (`src/resume.ts:245`) and at the end or on an error (`src/resume.ts:145`, `151`).
- With no sendable agent, nothing is saved until the end. The statuses that `sendAll` sets without a send (`self`, `gone`, already proven) reach the disk only at the next send save, the next proof poll or the end.

## Open record, process gone

- Broadcast and crash recovery: the record holds `pid` and `startTime` while a process runs it, and both are removed when it exits (`src/types.ts:362-367`, `src/types.ts:503-506`; `src/shared.ts:288-297`). A normal exit, an error and a stop signal (SIGINT, SIGTERM, SIGHUP) all clear them (`src/broadcast.ts:288-291`, `src/recover.ts:357-360`, `src/guard.ts:98-111`).
- So an open record with no `pid` means no process runs it. The docs say the same for a recovery (`docs/guide/how-it-works.md:77`).
- An open record that still has a `pid` means a process ran it and may still. The reader checks that the process is alive (`store.isProcessAlive`) and that its start time equals the recorded one (`store.processStartTime`). The hand-over uses exactly that test, plus a check that the lock file names the same pid and start time (`src/guard.ts:24-33`). A missing start time never proves it (`src/guard.ts:27`).
- A SIGKILL or a crash leaves the `pid` in an open record, and the lock behind. The lock is stale when its pid is dead, or alive with another start time (`src/store.ts:281-287`). The next command takes the lock over (`src/store.ts:289-301`, `407-421`). Nothing clears the record's `pid` until a command acts on that record.
- Pause run: `Run` has no `pid` or `startTime` (`src/types.ts:440-451`). A reader can only test the lock owner with `isProcessAlive` and `processStartTime`. With no live lock owner, no pause, resume or recover is running, and the open run waits for a `resume`. With a live lock owner, the run alone does not say which command holds the lock.

## Stale-data risks for a separate status command

1. `resume` saves nothing between its sends and its proof polls, and nothing at all when no agent is sendable. Statuses can show `pending` for agents that are already resolved in memory.
2. `pause` and `resume` write the same file with the same `pending` meaning. A status reader needs the lock owner and `continueSentAt` to name the phase.
3. `recover` in pause-run mode stores its rows in `run.recovery.rows`, not in a `recoveries/` file, and has no `pid`. A reader of `recoveries/` alone misses it.
4. `current` can name a record that is no longer the winner until a locking command runs `loadOpen`. Use `peekOpen`.
5. A SIGKILLed broadcast or crash recovery keeps its `pid` and stays `open`. It looks live to a reader that does not check the pid and the start time.
6. Saves are atomic renames, so a reader never sees a torn file. The data can still be one poll (2 s) old, and older inside a long `startAgent` or `send` call.
