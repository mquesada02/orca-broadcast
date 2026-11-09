import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string): Promise<string> => readFile(join(import.meta.dirname, '..', name), 'utf8');

describe('roster documents', () => {
  it('README holds the commands that turn the roster timer on and off, and its 5-minute interval', async () => {
    const readme = await read('README.md');
    expect(readme).toContain('systemctl --user enable --now');
    expect(readme).toContain('systemctl --user disable --now');
    expect(readme).toContain('OnUnitActiveSec=5min');
  });

  it('README documents the warnings field of --json and the automatic saves', async () => {
    const readme = await read('README.md');
    expect(readme).toContain('Every object has a `warnings` array');
    expect(readme).not.toContain('(not in `--json`)');
    expect(readme).toContain('`broadcast`, `pause` and `resume` also save the roster at their start and at their end');
  });

  it('CONTEXT.md defines the roster term', async () => {
    expect(await read('CONTEXT.md')).toMatch(/^\*\*Roster\*\*:/m);
  });
});

describe('recover crash mode documents', () => {
  it.each(['Crash mode', 'Recovery record', 'Restored agent', 'Restarted agent', 'Held session', 'Missing agent'])('CONTEXT.md defines the term %s', async (term) => {
    expect(await read('CONTEXT.md')).toMatch(new RegExp(`^\\*\\*${term}\\*\\*:`, 'm'));
  });

  it('CONTEXT.md defines the term Pause-run mode', async () => {
    expect(await read('CONTEXT.md')).toMatch(/^\*\*Pause-run mode\*\*:/m);
  });

  it('README describes pause-run mode and the worker sentence of resume', async () => {
    const readme = await read('README.md');
    expect(readme).toContain('pause-run mode');
    expect(readme).toContain('coordinator-not-paused');
    expect(readme).toMatch(/\*\*Resume\.\*\*[^\n]*stored missing workers[^\n]*worker-start --retry-of/);
  });

  it('README says that left-to-coordinator means the list was sent, not that the workers were restarted', async () => {
    expect(await read('README.md')).toMatch(/left-to-coordinator[^\n]*not[^\n]*restarted/);
  });

  it.each(['--timeout', '--yes', '--json', '--group'])('README Options row of %s names recover', async (flag) => {
    const options = (await read('README.md')).split('### Options')[1]?.split('\n### ')[0] ?? '';
    const row = options.split('\n').find((line) => line.startsWith(`| \`${flag}`));
    expect(row).toBeDefined();
    expect(row).toContain('`recover`');
  });
});

describe('session-ID identity documents', () => {
  it('ADR 0002 records that agents are identified across a restart by session ID', async () => {
    const adrs = await readdir(join(import.meta.dirname, '..', 'docs', 'adr'));
    const name = adrs.find((file) => file.startsWith('0002-'));
    expect(name).toBeDefined();
    expect(await read(join('docs', 'adr', name as string))).toMatch(/^# Agents are identified across a restart by Claude session ID, not `paneKey`/m);
  });

  it('ADR 0003 records that recover holds the lock, as an exception to ADR 0001', async () => {
    const adrs = await readdir(join(import.meta.dirname, '..', 'docs', 'adr'));
    const name = adrs.find((file) => file.startsWith('0003-'));
    expect(name).toBeDefined();
    const adr = await read(join('docs', 'adr', name as string));
    expect(adr).toMatch(/^# `recover` holds the lock: there is no hand-over from it/m);
    expect(adr).toContain('ADR 0001');
  });

  it('README names the recoveries folder of the record store', async () => {
    expect(await read('README.md')).toContain('`recoveries/`');
  });

  it('AGENTS.md holds the session-ID rule next to the paneKey gotcha', async () => {
    const agents = await read('AGENTS.md');
    expect(agents).toContain('Agents are identified by `paneKey`');
    expect(agents).toContain('Across a restart, agents are matched by Claude session ID (ADR 0002)');
  });
});
