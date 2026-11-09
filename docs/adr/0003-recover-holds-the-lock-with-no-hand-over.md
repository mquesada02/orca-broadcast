# `recover` holds the lock: there is no hand-over from it

ADR 0001 lets `pause` stop a waiting `broadcast` through the lock, because `pause` exists for urgent cases and a broadcast can wait minutes for acks. `recover` also waits for restarts and acks while it holds the lock, but it gets no such hand-over. While `recover` runs, `pause` and `close` refuse at once with the usual "another orca-broadcast is running", until `recover` ends or is interrupted. The hand-over check in the lock guard still matches only an open broadcast record, so a running `recover` is never sent a signal.

A recovery runs right after a restart, when an urgent `pause` is unlikely, and Ctrl-C stops `recover` at once. A hand-over would also need its own proof that the lock holder is the recovery, and a stopped `recover` leaves starts and prompts half done. When a recovery record is left open (the user stopped `recover`, or it timed out), `pause` does not need the lock to be handed over: it abandons the open recovery at its commit point, and `close` abandons it too.

## Considered options

- **Hand the lock over from `recover` as from `broadcast` (extend ADR 0001).** Rejected: the case it serves, an urgent pause during a recovery, is unlikely, and Ctrl-C already stops `recover`.
- **Let `recover` run without the lock.** Rejected: two commands could then start the same session or write one record at once.

## Consequences

- The user who needs `pause` while `recover` runs presses Ctrl-C in the `recover` terminal first, then runs `pause`. The record of the stopped recovery stays open and holds no pid; `pause` abandons it.
- The README says that there is no hand-over from `recover`.
