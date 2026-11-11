# The proof reads the Claude transcript as a second source of truth

`broadcast`, `recover` and `pause` used to prove a target only from Orca's last reply for the agent. When an agent takes another turn after its token reply, for example a background task wakes it, that turn's reply hides the token line. The target stayed `pending` with the reason `no-ack` until the timeout, although the agent had handled the message. `resume` had the opposite gap: a wake-up turn changes the state and the last reply, so it could count an agent as resumed that never took the CONTINUE message.

The commands now also read the Claude session transcript (`<config dir>/projects/<cwd slug>/<session id>.jsonl`), which keeps every reply. The transcript is a second source of truth beside Orca. A reply that ended a turn since the send, with the token line as its last line, proves the target, also when later turns follow. For `resume`, a user entry with the CONTINUE text proves the agent. Orca's last reply stays a proof, and either source proves a target. An agent with no readable transcript is proven as before. The research note [docs/research/reply-source.md](../research/reply-source.md) holds the facts behind this choice.

## Considered options

- **Read Orca's `terminal read`.** Rejected: it returns accumulated output with repainted lines as fragments, and it has no reply boundary.
- **Use Orca `search`.** Rejected: it is disabled by default, it indexes sessions with a delay, and it returns hits, not whole replies in order.
- **Read the whole transcript on every poll.** Rejected: transcripts reach 70 MB (median 3.6 MB). The commands record the transcript size at the send and read only the bytes added after it.

## Consequences

- The format of the transcript is undocumented: it is not a contract. A Claude Code update can change it. The commands ignore entries that they do not know. A transcript that cannot be read falls back to Orca's last reply, so the proof is never worse than before.
- `/clear` and a fork start a new session file. The old file is then no longer read, and the agent falls back to Orca's last reply.
- A transcript holds tool output and credentials in plaintext. The commands read only the fields that they need and store no transcript text in their records.
- A proof that was found is permanent. A transcript that is later changed, cleared or deleted does not undo it.
