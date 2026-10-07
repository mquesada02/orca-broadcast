# `pause` stops a waiting broadcast through the lock, and only a proven one

A `broadcast` holds the lock while it waits for acks, so an urgent `pause` would wait for its timeout. The lock guard therefore carries an optional hand-over used only by `pause`: when the lock owner's pid and start time equal those in the open broadcast record, and that process is alive with that start time, `pause` sends SIGTERM and waits 5 seconds for the lock. The broadcast treats SIGTERM like Ctrl-C, so its record stays open and holds no pid. Any other holder, a mismatch or a missing start time fails at once, so a reused pid is never signalled.

The signal is sent before the user answers the first prompt, because the prompt needs the lock. A decline therefore leaves the broadcast stopped, with its record open. This is accepted: prompting without the lock would let the lock owner change during the prompt. Nothing about the pause is written before the commit point (the user's "yes"); at the commit point the pause run is written, then the broadcast's unacked targets are abandoned with reason `paused` and the record is closed, in one write.

## Considered options

- **Kill whatever holds the lock.** Rejected: after pid reuse the owner can be an unrelated process.
- **Wait for the broadcast's timeout, or refuse (the interim rule of the first broadcast ticket).** Rejected: `pause` exists for urgent cases such as a lost network or a restart.
- **Put the hand-over inside `pause()`.** Rejected: the lock is taken in one shared place before `pause()` runs; only the guard can retry it.

## Consequences

- The start time comes from a Linux-only reader, so the hand-over works only on Linux.
- Between the proof and the signal a pid could in theory be reused; the start time is read again just before the signal to make that window as small as a check allows.
- A queued broadcast message can still be carried out by an agent just before the pause abandons it.
