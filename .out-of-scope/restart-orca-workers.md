# Restarting Orca workers

`recover` never restarts an Orca worker. It restarts a missing coordinator first, like any other agent, and tells each coordinator which of its workers are missing.

## Why this is out of scope

A worker belongs to an orchestration dispatch that its coordinator owns. The coordinator restarts it with `worker-start --retry-of`. A restart from outside orchestration would probably leave the dispatch tied to the old terminal (research #123).

So each coordinator learns about its missing workers instead:

- after a crash, through the continue prompt of `recover`;
- with an open pause run, through the CONTINUE message of `resume`.

The decision #125 and the spec #127 already decided this.

## Prior requests

- None.
