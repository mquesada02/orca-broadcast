---
name: orca-broadcast
description: Explain orca-broadcast and compose its command lines for the user to run. Use when the user names orca-broadcast or one of its commands with Orca, or asks to pause or resume their Claude agents (for example at a usage limit or before leaving), send one message to many sessions, restore sessions after a restart or crash, or manage saved groups or the roster.
---

# orca-broadcast

You explain `orca-broadcast` and write the exact command line. The user runs it. `pause`, `resume`, `broadcast` and `recover` message every matching agent on the machine, and `recover` can also start terminals. A run from your shell can reach all of them, this agent included.

## Hard rule: the only command you run

You run exactly these two forms, with no other flag or argument:

- `orca-broadcast --help`
- `orca-broadcast <command> --help`, where `<command>` is `pause`, `resume`, `close`, `broadcast`, `recover`, `group`, `roster` or `completion`

Help prints text, lists no Orca terminal and sends nothing. Every other command line, `roster save`, `group add` and `completion bash` included, you hand to the user. This rule also binds any subagent you start; copy it into its prompt.

## Steps

1. **Pick the page.** Match the request to one row. Done when you have one page, or two when the request spans them (for example a filter for `pause`).

   | Request | Page |
   |---|---|
   | Pause, resume, or close a pause run | `docs/guide/pause-and-resume.md` |
   | One message to many agents, or close an open broadcast | `docs/guide/broadcast.md` |
   | Restore agents after a restart or a crash, or close an open recovery | `docs/guide/recover.md` |
   | The roster of live agents | `docs/guide/roster.md` |
   | Choose which agents (`--repo`, `--worktree`, `--role`, `--state`, `--group`), or saved groups | `docs/guide/filters-and-groups.md` |
   | A flag, an exit code, `--json`, Tab completion | `docs/guide/reference.md` |
   | The lock, records, background work, limits | `docs/guide/how-it-works.md` |

2. **Read the facts.** Take every flag, exit code and message text from a source, never from memory. Use the first source that answers the question:
   1. The page in this repo, when the session runs in a checkout of `orca-broadcast`.
   2. `orca-broadcast <command> --help` (see the hard rule). `completion --help` prints only the top help, so for Tab completion skip to source 3.
   3. The page on GitHub: `https://github.com/mquesada02/orca-broadcast/blob/main/<page path>`.

   Done when each flag and exit code you will name has a source.

3. **Compose the command.**
   - Name the filter flags that limit the agents to the ones the user means, and say which agents they select. When the user wants every agent, give the command with no filter, and add one line that names the filter flags the user could add to narrow it.
   - Leave out `--yes`. A command that asks before it sends then shows its targets first. The step 2 source says which commands ask; say so only for those. When the user asks for `--json`, check in the step 2 source whether that command then needs `--yes`. If it does, explain this and let the user add `--yes` themselves.
   - Quote the text of `broadcast` for the shell.

   Done when the command uses only flags that step 2 confirmed.

4. **Hand it over.**
   - Give the command in a code block.
   - Tell the user to paste it into a plain terminal: an Orca shell tab with no Claude session. This chat and `! <command>` both run inside a Claude session.
   - Say why: a command run from a Claude session counts that session as `self`, so it is not paused like the others.
   - Say what the output and each exit code mean, from the step 2 source.

   Done when the user has the command, where to run it, and what each outcome means.
