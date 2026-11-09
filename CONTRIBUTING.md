# Contributing

This page tells you how to work on the code.

## Build and test

1. Install the dependencies: `pnpm install`
2. Run the tests: `pnpm test`
3. Check the types: `pnpm typecheck`
4. Build the command: `pnpm build`

Every test uses a fake Orca. No test needs a real Orca.

## Never touch real agents

Do not run the built command (`node dist/bin.js` or `orca-broadcast`) to test your change. Do not run any other command that sends to real Orca terminals. They send real messages to every working Claude session on your machine.

Verify behaviour only through the tests. The same rule is in `AGENTS.md`.

## Commit and PR style

- Write commit messages in the Conventional Commits style, for example `fix(broadcast): ...` or `docs: ...`.
- Keep each PR to one topic.
- The maintainer squash-merges each PR to `main`.

## Where things are

| What | Where |
|---|---|
| How the tool behaves | `README.md` and `docs/guide/` |
| Terms of the project | `CONTEXT.md` |
| Design decisions | `docs/adr/` |
| Notes for coding agents | `AGENTS.md` |
| Ideas that the project rules out | `.out-of-scope/` |
