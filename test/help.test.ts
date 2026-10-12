import { describe, expect, it } from 'vitest';
import { COMMANDS, flagsOf } from '../src/flags.js';
import { runCli } from './helpers/run-cli.js';
import { working } from './helpers/fake-orca.js';

const flagsListed = (help: string) => [...help.matchAll(/^ {2}--([a-z]+)/gm)].map((m) => m[1]).sort();
const agents = [{ paneKey: 'a:1', behavior: working }];

describe('top help', () => {
  it('lists the commands one line each and points to per-command help, without a flag table', async () => {
    const { code, out, err, port } = await runCli(['--help'], agents);
    expect(code).toBe(0);
    expect(err).toBe('');
    for (const name of [...COMMANDS, 'group']) expect(out).toMatch(new RegExp(`^  ${name} {2,}\\S`, 'm'));
    expect(out).toContain('run `orca-broadcast <command> --help` for its options');
    expect(flagsListed(out)).toEqual([]);
    expect(port.listCalls).toBe(0);
    expect(port.sends).toEqual([]);
  });

  it('is also what an unknown command with --help prints', async () => {
    const top = await runCli(['--help']);
    const unknown = await runCli(['bogus', '--help']);
    expect(unknown.code).toBe(0);
    expect(unknown.out).toBe(top.out);
  });
});

describe('per-command help', () => {
  it.each(COMMANDS)('%s lists the flags it accepts and no other, and calls no Orca', async (command) => {
    const { code, out, port } = await runCli([command, '--help'], agents);
    expect(code).toBe(0);
    expect(flagsListed(out)).toEqual(flagsOf(command).map(([name]) => name).sort());
    expect(port.listCalls).toBe(0);
  });

  it('matches what the parser accepts, flag by flag', async () => {
    const value: Record<string, string[]> = { role: ['worker'], state: ['working'], timeout: ['5s'], reason: ['end-of-day'], yes: [] };
    for (const command of COMMANDS) {
      const accepted = flagsOf(command).map(([name]) => name);
      for (const name of ['file', 'timeout', 'reason', 'yes', 'repo', 'worktree', 'role', 'run', 'state', 'group']) {
        const { err } = await runCli([command, `--${name}`, ...(value[name] ?? ['x'])], agents);
        expect(err.includes('applies only to'), `${command} --${name}`).toBe(!accepted.includes(name));
      }
    }
  });

  it('spot checks the flags that differ', async () => {
    const pause = (await runCli(['pause', '--help'])).out;
    expect(pause).toContain('--reason <name>');
    expect(pause).not.toContain('--state');
    const resume = (await runCli(['resume', '--help'])).out;
    expect(resume).not.toContain('--timeout');
    expect(resume).toContain('marked resumed with reason self');
    expect((await runCli(['close', '--help'])).out).not.toContain('--yes');
    const broadcast = (await runCli(['broadcast', '--help'])).out;
    expect(broadcast).toContain('--file <path>');
    expect(broadcast).toContain('--state');
    expect(broadcast).not.toContain('--reason');
  });

  it('notes where a flag means something different', async () => {
    for (const [command, note] of [['resume', 'Only narrows the recorded agents of the open run.'], ['close', 'Only narrows the recorded agents of the open run.'], ['pause', 'Waits for confirmations.'], ['broadcast', 'Waits for acks']]) {
      expect((await runCli([command!, '--help'])).out, command).toContain(note);
    }
  });

  it('wins over other flags and over --json', async () => {
    const { code, out, err } = await runCli(['pause', '--help', '--yes', '--json']);
    expect(code).toBe(0);
    expect(out).toContain('Usage: orca-broadcast pause');
    expect(err).toBe('');
  });
});

describe('group help', () => {
  it.each([['group', '--help'], ['group', 'add', '--help'], ['group', 'bogus', '--help'], ['group', 'remove', '--help']])('%j prints the group page', async (...argv) => {
    const { code, out } = await runCli(argv.flat());
    expect(code).toBe(0);
    for (const sub of ['group add', 'group list', 'group show', 'group remove']) expect(out).toContain(`orca-broadcast ${sub}`);
    expect(flagsListed(out)).toEqual(flagsOf('group add').map(([name]) => name).sort());
  });
});

describe('usage errors', () => {
  it.each([
    [['pause', '--bogus'], 'Usage: orca-broadcast pause'],
    [['close', '--yes'], 'Usage: orca-broadcast close'],
    [['broadcast', 'a', 'b'], 'Usage: orca-broadcast broadcast'],
    [['group', 'add'], 'Usage: orca-broadcast group add'],
    [['--repo', 'alpha', 'pause', '--bogus'], 'Usage: orca-broadcast pause'],
    [['bogus'], 'Usage: orca-broadcast <command>'],
    [[], 'Usage: orca-broadcast <command>'],
  ])('%j prints its error and a usage line, not the whole help', async (argv, usage) => {
    const { code, err } = await runCli(argv);
    expect(code).toBe(2);
    expect(err).toContain(usage);
    if (argv[0] && argv[0] !== 'bogus') expect(err).not.toContain('Flags:');
  });
});
