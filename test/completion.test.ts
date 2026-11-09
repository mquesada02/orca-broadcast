import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { BASH_SCRIPT, complete, TOP_WORDS } from '../src/completion.js';
import { COMMANDS, flagsOf } from '../src/flags.js';
import { FakeOrca } from './helpers/fake-orca.js';

const GROUPS = ['web', 'workers'];
const c = (...words: string[]) => complete(words, GROUPS);

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, env, { stdout: (t) => (out += t), stderr: (t) => (err += t), isTTY: false }, { port: new FakeOrca([]) });
  return { code, out, err };
}

describe('complete: the first word', () => {
  it('offers every command and the group, roster and completion words', () => {
    expect(c('')).toEqual([...TOP_WORDS]);
    expect(TOP_WORDS).toEqual([...COMMANDS, 'group', 'roster', 'completion']);
  });

  it('keeps only the words that start with what is typed', () => {
    expect(c('re')).toEqual(['resume', 'recover']);
    expect(c('pa')).toEqual(['pause']);
    expect(c('zz')).toEqual([]);
  });

  it('offers only --help and --json for a flag before any command', () => {
    expect(c('--')).toEqual(['--help', '--json']);
  });
});

describe('complete: the flags of a command', () => {
  it.each(COMMANDS)('offers exactly the flags that %s accepts', (command) => {
    expect(c(command, '--')).toEqual(flagsOf(command).map(([name]) => `--${name}`));
    expect(c(command, '')).toEqual(flagsOf(command).map(([name]) => `--${name}`));
  });

  it('never offers a flag that the command rejects', () => {
    expect(c('resume', '--')).not.toContain('--timeout');
    expect(c('close', '--')).not.toContain('--yes');
    expect(c('pause', '--re')).toEqual(['--reason', '--repo']);
  });

  it('drops a single-value flag already given, and keeps a flag that may repeat', () => {
    const flags = c('recover', '--yes', '--repo', 'alpha', '--');
    expect(flags).not.toContain('--yes');
    expect(flags).toContain('--repo');
  });

  it('offers nothing for a word that is not a flag, so bash falls back to file names', () => {
    expect(c('broadcast', 'hel')).toEqual([]);
    expect(c('bogus', '--')).toEqual([]);
  });
});

describe('complete: flag values', () => {
  it('offers the roles, the states, the reasons and the saved group names', () => {
    expect(c('pause', '--role', '')).toEqual(['coordinator', 'worker', 'session']);
    expect(c('broadcast', '--state', '')).toEqual(['working', 'done']);
    expect(c('pause', '--reason', 'e')).toEqual(['end-of-day']);
    expect(c('recover', '--group', 'w')).toEqual(['web', 'workers']);
  });

  it('offers nothing for a free value, and skips a given value when it reads the words', () => {
    expect(c('recover', '--timeout', '')).toEqual([]);
    expect(c('broadcast', '--file', '')).toEqual([]);
    expect(c('pause', '--repo', 'pause', '--')).toContain('--yes');
  });
});

describe('complete: the --flag=value form, which bash splits at =', () => {
  it('reads --role = worker as one flag with its value, not as a command', () => {
    expect(c('--role', '=', 'worker', 'pa')).toEqual(['pause']);
    expect(c('pause', '--role', '=', 'worker', '--')).toContain('--yes');
  });

  it('completes the value after =, keeping the = when it is the word being typed', () => {
    expect(c('pause', '--role', '=', 'wor')).toEqual(['worker']);
    expect(c('pause', '--role', '=')).toEqual(['=coordinator', '=worker', '=session']);
    expect(c('recover', '--timeout', '=', '')).toEqual([]);
  });
});

describe('complete: group, roster and completion', () => {
  it('offers the group subcommands, then the group names for show and remove', () => {
    expect(c('group', '')).toEqual(['add', 'list', 'show', 'remove']);
    expect(c('group', 'show', '')).toEqual(GROUPS);
    expect(c('group', 'remove', 'we')).toEqual(['web']);
    expect(c('group', 'show', 'web', '')).toEqual(['--help', '--json']);
  });

  it('offers the group add flags, and only --help and --json on the other group subcommands', () => {
    expect(c('group', 'add', 'x', '--')).toEqual(flagsOf('group add').map(([name]) => `--${name}`));
    expect(c('group', 'list', '--')).toEqual(['--help', '--json']);
  });

  it('offers save after roster, and bash after completion', () => {
    expect(c('roster', '')).toEqual(['save']);
    expect(c('roster', 'save', '--')).toEqual(['--help', '--json']);
    expect(c('completion', '')).toEqual(['bash']);
    expect(c('completion', 'bash', '')).toEqual([]);
  });
});

describe('the CLI', () => {
  it('prints the bash script for completion bash and exits 0', async () => {
    const { code, out, err } = await run(['completion', 'bash']);
    expect([code, out, err]).toEqual([0, BASH_SCRIPT, '']);
    expect(out).toContain('complete -o default -F _orca_broadcast orca-broadcast');
    expect(out).toContain('orca-broadcast __complete "${COMP_WORDS[@]:1:COMP_CWORD}"');
  });

  it('refuses completion with another shell or a flag, exit 2', async () => {
    expect((await run(['completion', 'zsh'])).code).toBe(2);
    expect((await run(['completion'])).code).toBe(2);
    expect((await run(['completion', 'bash', '--json'])).code).toBe(2);
  });

  it('answers __complete with one candidate per line, reading the group names from the groups file', async () => {
    const config = await mkdtemp(join(tmpdir(), 'orca-broadcast-completion-'));
    await mkdir(join(config, 'orca-broadcast'));
    const spec = { repo: ['alpha'], worktree: [], role: [], run: [], state: [] };
    await writeFile(join(config, 'orca-broadcast', 'groups.json'), JSON.stringify({ version: 1, groups: { web: spec } }));
    const { code, out } = await run(['__complete', 'pause', '--group', ''], { XDG_CONFIG_HOME: config });
    expect([code, out]).toEqual([0, 'web\n']);
  });

  it('passes flags typed by the user through __complete without parsing them, and still completes with an unreadable groups file', async () => {
    const config = await mkdtemp(join(tmpdir(), 'orca-broadcast-completion-'));
    await mkdir(join(config, 'orca-broadcast'));
    await writeFile(join(config, 'orca-broadcast', 'groups.json'), 'not json');
    const { code, out } = await run(['__complete', 'pause', '--bogus', '--yes', '--ro'], { XDG_CONFIG_HOME: config });
    expect([code, out]).toEqual([0, '--role\n']);
  });

  it('lists completion in the top help', async () => {
    const { out } = await run(['--help']);
    expect(out).toMatch(/^ {2}completion +Print the bash Tab completion script/m);
  });
});
