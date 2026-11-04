import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentRecord, broadcastTarget, openBroadcastRecord, seedOpenRun } from './helpers/fake-orca.js';
import { doneEntry, GONE, parseJson, recoverRun, resultsOf } from './helpers/recover.js';
import { readBroadcasts } from './helpers/records.js';
import { agent, minutesBefore, readRoster, rosterEntry, rosterNames, rosterSnapshot, scanOf, seedRosters } from './helpers/roster.js';
import { runCli, seedGroups, type Seed } from './helpers/run-cli.js';
import { FALLBACK_NOTICE } from '../src/recover-set.js';

const stateEntries = async (dir: string): Promise<string[]> => (await readdir(join(dir, 'orca-broadcast')).catch(() => ['<no state folder>'])).sort();

describe('refusals', () => {
  it('refuses without a roster and without an open pause run, and writes nothing', async () => {
    const { code, err, dir, port } = await runCli(['recover', '--yes']);
    expect(code).toBe(2);
    expect(err).toContain('no roster and no open pause run; nothing to recover from');
    expect(await stateEntries(dir)).toEqual([]);
    expect(port.scanCalls).toBe(0);
  });

  it('refuses when a kept roster file cannot be read, naming the file', async () => {
    const seed: Seed = async (_store, dir) => {
      const folder = join(dir, 'orca-broadcast', 'roster');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'broken.json'), '{not json');
    };
    const { code, err, port } = await runCli(['recover', '--yes'], [], { seed });
    expect(code).toBe(2);
    expect(err).toMatch(/cannot read roster file .*broken\.json: /);
    expect(port.scanCalls).toBe(0);
  });

  it('refuses when the first listing fails, with the error that broadcast prints, before any scan', async () => {
    const { code, err, port, out } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { configure: (p) => (p.listError = new Error('orca-ide worktree ps failed: down')) });
    expect(code).toBe(2);
    expect(port.scanCalls).toBe(0);
    expect(err).toBe('');
    const line = parseJson(out);
    expect([line.outcome, line.error, line.rows, line.snapshots]).toEqual(['error', 'orca-ide worktree ps failed: down', [], []]);
  });

  it('refuses when the boot ID cannot be read, with no snapshot lines yet', async () => {
    const { code, out } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { configure: (p) => (p.failBootId = true) });
    expect(code).toBe(2);
    const line = parseJson(out);
    expect(line.error).toBe('cannot scan Claude processes: fake orca: boot id unreadable');
    expect(line.snapshots).toEqual([]);
  });

  it('refuses when the first scan fails: the snapshot lines read are in the error line, and the roster is not touched', async () => {
    const { code, out, dir, port } = await recoverRun(['--yes', '--json'], [], [doneEntry('s-a')], { configure: (p) => (p.failScansFrom = 1) });
    expect(code).toBe(2);
    const line = parseJson(out);
    expect([line.outcome, line.exitCode, line.error, line.rows]).toEqual(['error', 2, 'cannot scan Claude processes: fake orca: scan failed', []]);
    expect(line.snapshots).toEqual([{ lastSave: minutesBefore(5), ageMinutes: 5 }]);
    expect(await rosterNames(dir)).toEqual(['boot-0-runtime-0.json']);
    expect(port.starts).toEqual([]);
  });

  it('refuses while a broadcast is open, and leaves the record as it was', async () => {
    const seed: Seed = async (store) => {
      await seedRosters(rosterSnapshot(GONE, [doneEntry('s-a')]))(store);
      await store.saveBroadcast(openBroadcastRecord([broadcastTarget('a:1')]));
      await store.setCurrent('broadcast', 'b-1');
    };
    const { code, err, port, dir } = await runCli(['recover', '--yes'], [], { seed });
    expect(code).toBe(2);
    expect(err).toContain('a broadcast is still open; run `orca-broadcast close` and then `recover` again');
    expect(port.listCalls).toBe(0);
    expect((await readBroadcasts(dir)).map((r) => [r.id, r.status])).toEqual([['b-1', 'open']]);
  });

  // The guard is temporary (approved by the user): ticket 134 removes it with this test.
  it('refuses while a pause run is open (temporary), and repairs nothing: an open broadcast beside it stays open', async () => {
    const seed: Seed = async (store) => {
      await seedRosters(rosterSnapshot(GONE, [doneEntry('s-a')]))(store);
      await seedOpenRun(store, [agentRecord('a:1')]);
      await store.saveBroadcast(openBroadcastRecord([broadcastTarget('a:1')]));
    };
    const { code, err, port, dir } = await runCli(['recover', '--yes'], [], { seed });
    expect(code).toBe(2);
    expect(err).toContain('a pause run is open; recover with an open pause run is not available yet');
    expect(port.listCalls).toBe(0);
    expect((await readBroadcasts(dir)).map((r) => r.status)).toEqual(['open']);
  });

  it('refuses without a terminal and without --yes before it reads, locks or lists anything', async () => {
    const { code, err, port, dir } = await recoverRun([], [], [doneEntry('s-a')]);
    expect(code).toBe(2);
    expect(err).toContain('refusing to send without an interactive terminal: pass --yes to confirm');
    expect([port.listCalls, port.scanCalls]).toEqual([0, 0]);
    expect(await stateEntries(dir)).toEqual(['roster']);
  });

  it('under --json without --yes, the error line has the recover shape with empty rows and snapshots', async () => {
    const { code, out } = await recoverRun(['--json'], [], [doneEntry('s-a')]);
    expect(code).toBe(2);
    expect(out).toBe(
      '{"command":"recover","outcome":"error","exitCode":2,"run":null,"record":null,"error":"refusing to send without an interactive terminal: pass --yes to confirm","rows":[],"snapshots":[],"warnings":[]}\n',
    );
  });

  it('refuses while another orca-broadcast holds the lock', async () => {
    const seed: Seed = async (store) => {
      await seedRosters(rosterSnapshot(GONE, [doneEntry('s-a')]))(store);
      await store.acquireLock();
    };
    const { code, err, port } = await runCli(['recover', '--yes'], [], { seed });
    expect(code).toBe(2);
    expect(err).toContain('another orca-broadcast is running');
    expect(port.listCalls).toBe(0);
  });

  it.each([
    [['--state', 'working'], '--state applies only to broadcast'],
    [['--reason', 'away'], '--reason applies only to pause'],
    [['--file', 'x.txt'], '--file applies only to broadcast'],
  ])('refuses %j', async (flags, message) => {
    const { code, err, port } = await recoverRun(['--yes', ...flags], [], [doneEntry('s-a')]);
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(port.listCalls).toBe(0);
  });
});

describe('help', () => {
  it('has a recover topic with its usage, and the top help lists it', async () => {
    const topic = await runCli(['recover', '--help']);
    expect(topic.code).toBe(0);
    expect(topic.out).toContain('Usage: orca-broadcast recover [filters] [--timeout <n>s|m|h] [--yes]');
    expect(topic.out).toContain('--group <name>');
    expect(topic.out).not.toContain('--state');
    expect((await runCli(['--help'])).out).toMatch(/\n {2}recover {4}Show which agents were alive/);
  });
});

describe('the pre-restart set', () => {
  it('shows one header line per snapshot used, with its age in whole minutes', async () => {
    const { out } = await recoverRun(['--yes'], [], [doneEntry('s-a')], { ageMinutes: 5 });
    expect(out.startsWith(`snapshot ${minutesBefore(5)} (5 minutes old)\n\n`)).toBe(true);
  });

  it.each([
    [0, '0 minutes'],
    [1, '1 minute'],
    [2, '2 minutes'],
  ])('prints an age of %i as "%s old"', async (age, text) => {
    const { out } = await recoverRun(['--yes'], [], [doneEntry('s-a')], { ageMinutes: age });
    expect(out).toContain(`(${text} old)`);
  });

  it.each([
    [59, ['s-new', 's-old']],
    [60, ['s-new']],
    [61, ['s-new']],
  ])('adds the older snapshot only when the newer runtime lived less than 60 minutes (%i minutes)', async (life, expected) => {
    const older = rosterSnapshot({ bootId: 'boot-0', runtimeId: 'runtime-old' }, [doneEntry('s-old')], 100, 600);
    const newer = rosterSnapshot({ bootId: 'boot-0', runtimeId: 'runtime-new' }, [doneEntry('s-new')], 5, life);
    const { out } = await recoverRun(['--yes', '--json'], [], [], { seed: seedRosters(older, newer) });
    expect(Object.keys(resultsOf(out)).sort()).toEqual(expected);
    expect(parseJson(out).snapshots).toHaveLength(expected.length);
  });

  it('merges the snapshots by session ID, and the entry of the newer snapshot wins', async () => {
    const older = rosterSnapshot({ bootId: 'boot-0', runtimeId: 'runtime-old' }, [doneEntry('s-same', { worktree: 'old-tree' })], 100, 600);
    const newer = rosterSnapshot({ bootId: 'boot-0', runtimeId: 'runtime-new' }, [doneEntry('s-same', { worktree: 'new-tree' })], 5, 10);
    const { out } = await recoverRun(['--yes', '--json'], [], [], { seed: seedRosters(older, newer) });
    expect(parseJson(out).rows.map((row) => row.worktree)).toEqual(['new-tree']);
  });

  it('goes back no further than the 5 kept snapshots: 6 short runtimes saved in order use the newest 5', async () => {
    const snapshots = [1, 2, 3, 4, 5, 6].map((i) => rosterSnapshot({ bootId: 'boot-0', runtimeId: `runtime-${i}` }, [doneEntry(`s-${i}`)], 700 - i * 100, 10));
    const { out, dir } = await recoverRun(['--yes', '--json'], [], [], { seed: seedRosters(...snapshots) });
    expect(Object.keys(resultsOf(out)).sort()).toEqual(['s-2', 's-3', 's-4', 's-5', 's-6']);
    expect(parseJson(out).snapshots).toHaveLength(5);
    expect(await rosterNames(dir)).toHaveLength(5);
  });

  it('falls back to the live runtime snapshot with a notice, and the start save does not drop the dead agents before they are read', async () => {
    const live = rosterSnapshot({ bootId: 'boot-1', runtimeId: 'runtime-1' }, [doneEntry('s-dead')], 5, 600);
    const { out, err, dir } = await recoverRun(['--yes'], [], [], { seed: seedRosters(live) });
    expect(err).toBe(`orca-broadcast: ${FALLBACK_NOTICE}\n`);
    expect(out).toMatch(/tree-s-dead\s+session\s+failed\s+did-not-appear/);
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries).toEqual([]);
    const json = await recoverRun(['--yes', '--json'], [], [], { seed: seedRosters(live) });
    expect(parseJson(json.out).warnings).toEqual([FALLBACK_NOTICE]);
    expect(json.err).toBe('');
  });

  it('treats a null runtime ID as unknown: only the boot IDs are compared', async () => {
    const sameBoot = await recoverRun(['--yes', '--json'], [], [], { seed: seedRosters(rosterSnapshot({ bootId: 'boot-1', runtimeId: null }, [doneEntry('s-a')])) });
    expect(parseJson(sameBoot.out).warnings).toEqual([FALLBACK_NOTICE]);
    const otherBoot = await recoverRun(['--yes', '--json'], [], [], { seed: seedRosters(rosterSnapshot({ bootId: 'boot-0', runtimeId: null }, [doneEntry('s-a')])) });
    expect(parseJson(otherBoot.out).warnings).toEqual([]);
  });

  it('is "nothing to recover" for a snapshot with no agent: exit 0, the header lines, outcome nothing-to-do', async () => {
    const text = await recoverRun(['--yes'], [], []);
    expect(text.code).toBe(0);
    expect(text.out).toBe(`snapshot ${minutesBefore(5)} (5 minutes old)\nnothing to recover\n`);
    const json = await recoverRun(['--yes', '--json'], [], []);
    const line = parseJson(json.out);
    expect([line.outcome, line.exitCode, line.rows, line.snapshots]).toEqual(['nothing-to-do', 0, [], [{ lastSave: minutesBefore(5), ageMinutes: 5 }]]);
  });

  it('keeps the pre-restart file and writes the roster of the live runtime after the first scan, with one scan', async () => {
    const { dir, port } = await recoverRun(['--yes'], [agent('new:a')], [doneEntry('s-a')], { scan: scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }) });
    expect(await rosterNames(dir)).toEqual(['boot-0-runtime-0.json', 'boot-1-runtime-1.json']);
    expect((await readRoster(dir, 'boot-0-runtime-0.json')).entries.map((e) => e.sessionId)).toEqual(['s-a']);
    expect([port.scanCalls, port.listCalls]).toEqual([1, 1]);
  });
});

describe('output', () => {
  it('orders rows coordinators first, then by repo, worktree, session ID', async () => {
    const at = (id: string, repo: string, worktree: string, role: 'session' | 'coordinator' = 'session') => doneEntry(id, { repo, repoId: `repo-${repo}`, worktree, role });
    const entries = [at('z', 'r2', 't1'), at('y', 'r1', 't2'), at('x', 'r1', 't1'), at('w', 'r3', 't9', 'coordinator'), at('v', 'r1', 't1')];
    const { out } = await recoverRun(['--yes', '--json'], [], entries);
    expect(parseJson(out).rows.map((row) => row.sessionId)).toEqual(['w', 'v', 'x', 'y', 'z']);
  });

  it('prints the table header, and a dash for a row with no reason', async () => {
    const live = [{ paneKey: 'new:a', behavior: () => ({ state: 'working', message: null }) }];
    const { out } = await recoverRun(['--yes'], live, [doneEntry('s-a')], { scan: scanOf({ sessionId: 's-a', paneKey: 'new:a', startTime: 5 }) });
    expect(out).toContain('  repo  worktree  role     status    reason\n  repo  tree-s-a  session  restored  -\n');
  });

  it('prints the exact --json keys, in order, for the line and for each row', async () => {
    const { out } = await recoverRun(['--yes', '--json'], [], [rosterEntry('s-w', { role: 'worker', dispatchId: 'd-9' })]);
    const line = parseJson(out);
    expect(Object.keys(line)).toEqual(['command', 'outcome', 'exitCode', 'run', 'record', 'error', 'rows', 'snapshots', 'warnings']);
    expect(Object.keys(line.rows[0] as object)).toEqual(['sessionId', 'repo', 'worktree', 'worktreePath', 'role', 'status', 'reason', 'dispatchId']);
    expect(line.rows[0]).toEqual({ sessionId: 's-w', repo: 'repo', worktree: 'tree-s-w', worktreePath: '/work/tree-s-w', role: 'worker', status: 'no-coordinator', reason: 'coordinator-missing', dispatchId: 'd-9' });
    expect([line.command, line.outcome, line.exitCode, line.run, line.record, line.error]).toEqual(['recover', 'done', 1, null, null, null]);
  });

  it('a declined confirmation is outcome done with exit 1 and its rows', async () => {
    const declined = await runCli(['recover'], [], { ask: ['n'], seed: seedRosters(rosterSnapshot(GONE, [rosterEntry('s-a')])) });
    expect(declined.code).toBe(1);
    expect(declined.out).toMatch(/pending\s+declined/);
  });
});

describe('filters and groups', () => {
  const entries = [
    doneEntry('s-1', { repo: 'r1', repoId: 'repo-r1', orchestrationRunIds: ['run_1'] }),
    doneEntry('s-2', { repo: 'r2', repoId: 'repo-r2', role: 'coordinator' }),
    doneEntry('s-3', { repo: 'r1', repoId: 'repo-r1', worktree: 'wt-three', worktreeId: 'wt-3' }),
  ];
  const rowsOf = async (filters: string[], seed?: Seed) => Object.keys(resultsOf((await recoverRun(['--yes', '--json', ...filters], [], entries, seed ? { seed } : {})).out)).sort();

  it('--repo, --role, --run and --worktree select the recovery set', async () => {
    expect(await rowsOf(['--repo', 'r1'])).toEqual(['s-1', 's-3']);
    expect(await rowsOf(['--role', 'coordinator'])).toEqual(['s-2']);
    expect(await rowsOf(['--run', 'run_1'])).toEqual(['s-1']);
    expect(await rowsOf(['--worktree', 'wt-three'])).toEqual(['s-3']);
  });

  it('--group selects by the saved filters, and skips the state kind with the usual line', async () => {
    const seed: Seed = async (store, dir) => {
      await seedRosters(rosterSnapshot(GONE, entries))(store);
      await seedGroups({ g: { repo: ['r2'], state: ['working'] } })(store, dir);
    };
    const run = await recoverRun(['--yes', '--json', '--group', 'g'], [], entries, { seed });
    expect(Object.keys(resultsOf(run.out))).toEqual(['s-2']);
    expect(run.err).toBe('orca-broadcast: group g: state filter skipped (recover does not use it)\n');
  });

  it('a filter that leaves no row is "nothing to recover" and exit 0; an unknown value is a refusal', async () => {
    const none = await recoverRun(['--yes', '--role', 'worker'], [], entries);
    expect([none.code, none.out.endsWith('nothing to recover\n')]).toEqual([0, true]);
    const unknown = await recoverRun(['--yes', '--repo', 'nowhere'], [], entries);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown --repo "nowhere"');
  });
});
