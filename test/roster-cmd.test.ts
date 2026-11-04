import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { topHelp } from '../src/help.js';
import { FakeOrca, tempStateDir } from './helpers/fake-orca.js';
import { agent, readRosterText, rosterFolder, rosterNames, rosterRun, scanOf } from './helpers/roster.js';

const one = (p: FakeOrca) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1' }));
const FILE = 'boot-1-runtime-1.json';

describe('roster save: output and exit codes', () => {
  it('prints the count and exits 0; the word stays "agents" for one', async () => {
    const dir = await tempStateDir();
    const { code, out, err } = await rosterRun(dir, [agent('a:1')], { configure: one });
    expect([code, out, err]).toEqual([0, 'roster saved: 1 agents\n', '']);
  });

  it('prints one JSON line with exactly four keys when saved', async () => {
    const dir = await tempStateDir();
    const { code, out } = await rosterRun(dir, [agent('a:1')], { configure: one, argv: ['roster', 'save', '--json'] });
    expect([code, out]).toEqual([0, '{"command":"roster save","outcome":"saved","agents":1,"warnings":[]}\n']);
  });
});

describe('roster save: a skipped save', () => {
  const failures: [string, (p: FakeOrca) => void, RegExp][] = [
    ['an agent listing fails', (p) => (p.failListingsFrom = 1), /worktree ps failed: down/],
    ['the terminal listing fails', (p) => (p.listTerminals = async () => { throw new Error('terminal list boom'); }), /terminal list boom/],
    ['the run listing fails', (p) => (p.failRunListsFrom = 1), /run-list failed/],
    ['the worker listing fails', (p) => (p.failWorkerListsFrom = 1), /worker-list failed/],
    ['the scan fails', (p) => (p.failScansFrom = 1), /scan failed/],
    ['the boot ID cannot be read', (p) => (p.failBootId = true), /boot id unreadable/],
  ];

  it.each(failures)('exits 1, says why and leaves the last snapshot untouched when %s', async (_name, configure, reason) => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1')], { configure: one });
    const before = await readRosterText(dir, FILE);
    const { code, out } = await rosterRun(dir, [agent('a:1')], { configure: (p) => { one(p); configure(p); } });
    expect(code).toBe(1);
    expect(out).toMatch(/^roster not saved: /);
    expect(out).toMatch(reason);
    expect(await readRosterText(dir, FILE)).toBe(before);
    const json = JSON.parse((await rosterRun(dir, [agent('a:1')], { configure: (p) => { one(p); configure(p); }, argv: ['roster', 'save', '--json'] })).out);
    expect(json).toMatchObject({ command: 'roster save', outcome: 'skipped', agents: null });
    expect(json.warnings).toHaveLength(1);
    expect(json.warnings[0]).toMatch(reason);
    expect(Object.keys(json)).toEqual(['command', 'outcome', 'agents', 'warnings']);
  });

  it.each([['invalid JSON', '{"half":'], ['a wrong shape', '[]'], ['a snapshot with no entries list', '{"bootId":"b","runtimeId":null,"firstSavedAt":"x","lastSavedAt":"y"}']])('is skipped, naming the file, when a roster file holds %s', async (_name, content) => {
    const dir = await tempStateDir();
    await mkdir(rosterFolder(dir), { recursive: true });
    await writeFile(join(rosterFolder(dir), 'bad.json'), content);
    const { code, out } = await rosterRun(dir, [agent('a:1')], { configure: one });
    expect(code).toBe(1);
    expect(out).toMatch(/^roster not saved: cannot read roster file .*bad\.json: /);
    expect(await rosterNames(dir)).toEqual(['bad.json']);
  });

  it('is skipped when the write fails, and leaves the last snapshot untouched', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1')], { configure: one });
    const before = await readRosterText(dir, FILE);
    await mkdir(join(rosterFolder(dir), `${FILE}.4242.sfx.tmp`));
    const { code, out } = await rosterRun(dir, [agent('a:1')], { configure: one });
    expect([code, out.startsWith('roster not saved: ')]).toEqual([1, true]);
    expect(await readRosterText(dir, FILE)).toBe(before);
  });

  it('is skipped, not an exit 2, when roster/ is a file', async () => {
    const dir = await tempStateDir();
    await mkdir(join(dir, 'orca-broadcast'), { recursive: true });
    await writeFile(rosterFolder(dir), 'not a folder');
    const { code, out } = await rosterRun(dir, [agent('a:1')], { configure: one });
    expect([code, out.startsWith('roster not saved: ')]).toEqual([1, true]);
  });
});

describe('roster save: what it touches', () => {
  it('lists once per kind, scans once, sends nothing and writes only roster/', async () => {
    const dir = await tempStateDir();
    const { port } = await rosterRun(dir, [agent('a:1')], { configure: one });
    expect([port.listCalls, port.listTerminalsCalls, port.listRunsCalls, port.listWorkersCalls, port.scanCalls]).toEqual([1, 1, 1, 1, 1]);
    expect(port.sends).toEqual([]);
    expect(port.starts).toEqual([]);
    expect(await readdir(join(dir, 'orca-broadcast'))).toEqual(['roster']);
  });

  it('takes no lock: it works while another process holds the lock, and leaves the lock file alone', async () => {
    const dir = await tempStateDir();
    await mkdir(join(dir, 'orca-broadcast'), { recursive: true });
    await writeFile(join(dir, 'orca-broadcast', 'lock'), `${process.pid}\n`);
    const { code } = await rosterRun(dir, [agent('a:1')], { configure: one });
    expect(code).toBe(0);
    expect((await readdir(join(dir, 'orca-broadcast'))).sort()).toEqual(['lock', 'roster']);
  });

  it('never touches an open record or the pointer', async () => {
    const dir = await tempStateDir();
    await mkdir(join(dir, 'orca-broadcast', 'pauses'), { recursive: true });
    await writeFile(join(dir, 'orca-broadcast', 'pauses', 'r.json'), '{"runId":"r","status":"open"}');
    await writeFile(join(dir, 'orca-broadcast', 'current'), '{"kind":"pause","id":"r"}\n');
    await rosterRun(dir, [agent('a:1')], { configure: one });
    expect((await readdir(join(dir, 'orca-broadcast'))).sort()).toEqual(['current', 'pauses', 'roster']);
    expect(await readdir(join(dir, 'orca-broadcast', 'pauses'))).toEqual(['r.json']);
  });
});

describe('roster save: usage errors', () => {
  const cases: [string[], string, string][] = [
    [['roster'], 'roster', 'missing roster subcommand'],
    [['roster', 'bogus'], 'roster', 'unknown roster subcommand "bogus"'],
    [['roster', 'save', 'extra'], 'roster save', 'roster save takes no argument'],
    [['roster', 'save', '--yes'], 'roster save', '--yes does not apply to roster save'],
    [['roster', 'save', '--timeout', '5m'], 'roster save', '--timeout does not apply to roster save'],
    [['roster', 'save', '--repo', 'x'], 'roster save', '--repo does not apply to roster save'],
  ];

  it.each(cases)('%j exits 2 with a message and the roster usage line', async (argv, _label, message) => {
    const dir = await tempStateDir();
    const { code, out, err, port } = await rosterRun(dir, [agent('a:1')], { argv });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain(`orca-broadcast: ${message}\n`);
    expect(err).toContain('Usage: orca-broadcast roster save [--json]');
    expect(port.listCalls).toBe(0);
    expect(await rosterNames(dir)).toEqual([]);
  });

  it.each(cases)('%j under --json prints the error object', async (argv, label, message) => {
    const dir = await tempStateDir();
    const { code, out, err } = await rosterRun(dir, [agent('a:1')], { argv: [...argv, '--json'] });
    expect(code).toBe(2);
    expect(err).toBe('');
    expect(out).toBe(`${JSON.stringify({ command: label, outcome: 'error', exitCode: 2, error: message, agents: null, warnings: [] })}\n`);
  });
});

describe('roster help', () => {
  it.each([['roster', '--help'], ['roster', 'save', '--help'], ['roster', 'bogus', '--help']])('%j prints the roster page', async (...argv) => {
    const dir = await tempStateDir();
    const { code, out, port } = await rosterRun(dir, [], { argv });
    expect(code).toBe(0);
    expect(out).toContain('Usage: orca-broadcast roster save [--json]');
    expect(out).toMatch(/--json\n\s+Print one JSON object/);
    expect(port.listCalls).toBe(0);
  });

  it('is listed in the top help', () => {
    expect(topHelp()).toMatch(/^ {2}roster {2,}\S/m);
  });
});
