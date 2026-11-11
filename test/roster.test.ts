import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSnapshot } from '../src/shared.js';
import type { RosterEntry } from '../src/types.js';
import { fakeClock, FakeOrca, tempStateDir } from './helpers/fake-orca.js';
import { agent, readRoster, readRosterText, rosterEntry, rosterFolder, rosterNames, rosterRun, scanOf, T0 } from './helpers/roster.js';

const BYPASS = '--permission-mode bypassPermissions';

describe('listSnapshot', () => {
  it('lists once per kind and pairs the runtime ID with the rows of the same call', async () => {
    const port = new FakeOrca([agent('a:1', { rowAt: (n) => n === 1 }), agent('b:2', { rowAt: (n) => n === 2 })]);
    port.runtimeIdAt = (n) => `rt-${n}`;
    const first = await listSnapshot({ port, clock: fakeClock() });
    expect([...first.agents.keys(), first.runtimeId]).toEqual(['a:1', 'rt-1']);
    const second = await listSnapshot({ port, clock: fakeClock() });
    expect([...second.agents.keys(), second.runtimeId]).toEqual(['b:2', 'rt-2']);
    expect([port.listCalls, port.listTerminalsCalls, port.listRunsCalls, port.listWorkersCalls]).toEqual([2, 2, 2, 2]);
  });

  it('carries the run list and the worker list', async () => {
    const port = new FakeOrca([agent('c:1'), agent('w:1')]);
    port.coordinatorsAt = () => ['c:1'];
    port.workersAt = () => [{ paneKey: 'w:1', runId: 'run_0', dispatchId: 'd-1' }];
    const snapshot = await listSnapshot({ port, clock: fakeClock() });
    expect(snapshot.runs).toEqual([{ id: 'run_0', coordinatorHandle: 'term_c:1' }]);
    expect(snapshot.workers).toEqual([{ handle: 'term_w:1', runId: 'run_0', dispatchId: 'd-1' }]);
  });
});

describe('roster entries', () => {
  it('holds exactly the spec fields and never reply text', async () => {
    const dir = await tempStateDir();
    const { code } = await rosterRun(dir, [agent('a:1', { stateStartedAt: 77, behavior: () => ({ state: 'working', message: 'SECRET REPLY' }) })], {
      configure: (p) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1', permission: BYPASS, cwd: '/secret/cwd' })),
    });
    expect(code).toBe(0);
    const text = await readRosterText(dir, 'boot-1-runtime-1.json');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('/secret/cwd');
    const roster = await readRoster(dir, 'boot-1-runtime-1.json');
    expect(Object.keys(roster).sort()).toEqual(['bootId', 'entries', 'firstSavedAt', 'lastSavedAt', 'runtimeId']);
    expect(roster).toMatchObject({ bootId: 'boot-1', runtimeId: 'runtime-1', firstSavedAt: '2026-03-01T00:00:00.000Z', lastSavedAt: '2026-03-01T00:00:00.000Z' });
    expect(roster.entries).toEqual([
      {
        sessionId: 's1',
        paneKey: 'a:1',
        repo: 'repo',
        repoId: 'repo-repo',
        worktree: 'tree-a:1',
        worktreeId: 'wt-a:1',
        worktreePath: '/work/tree-a:1',
        role: 'session',
        orchestrationRunIds: [],
        state: 'working',
        stateStartedAt: 77,
        savedAt: '2026-03-01T00:00:00.000Z',
        permission: BYPASS,
      },
    ]);
  });

  it('maps every state other than working and done to waiting, and omits an unknown permission', async () => {
    const dir = await tempStateDir();
    const states = ['working', 'done', 'waiting', 'blocked'];
    const agents = states.map((state, i) => agent(`p:${i}`, { behavior: () => ({ state, message: null }) }));
    await rosterRun(dir, agents, { configure: (p) => (p.scanAt = () => scanOf(...states.map((_, i) => ({ sessionId: `s${i}`, paneKey: `p:${i}` })))) });
    const { entries } = await readRoster(dir, 'boot-1-runtime-1.json');
    expect(entries.map((e) => e.state)).toEqual(['working', 'done', 'waiting', 'waiting']);
    expect(entries.every((e) => !('permission' in e))).toBe(true);
  });

  it('gives a worker its coordinator by the parent link, and its dispatch ID', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('c:1'), agent('w:1', { parentPaneKey: 'c:1' })], {
      configure: (p) => {
        p.workersAt = () => [{ paneKey: 'w:1', runId: 'run_0', dispatchId: 'd-1' }];
        p.scanAt = () => scanOf({ sessionId: 'sc', paneKey: 'c:1' }, { sessionId: 'sw', paneKey: 'w:1' });
      },
    });
    const { entries } = await readRoster(dir, 'boot-1-runtime-1.json');
    expect(entries.find((e) => e.paneKey === 'w:1')).toMatchObject({ role: 'worker', coordinatorSessionId: 'sc', dispatchId: 'd-1', orchestrationRunIds: ['run_0'] });
    expect(entries.find((e) => e.paneKey === 'c:1')).not.toHaveProperty('coordinatorSessionId');
    expect(entries.find((e) => e.paneKey === 'c:1')).not.toHaveProperty('dispatchId');
  });

  it("falls back to the run's coordinator terminal when the worker has no parent link", async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('c:1'), agent('w:1')], {
      configure: (p) => {
        p.coordinatorsAt = () => ['c:1'];
        p.workersAt = () => [{ paneKey: 'w:1', runId: 'run_0' }];
        p.scanAt = () => scanOf({ sessionId: 'sc', paneKey: 'c:1' }, { sessionId: 'sw', paneKey: 'w:1' });
      },
    });
    const worker = (await readRoster(dir, 'boot-1-runtime-1.json')).entries.find((e) => e.paneKey === 'w:1') as RosterEntry;
    expect(worker).toMatchObject({ role: 'worker', coordinatorSessionId: 'sc' });
    expect(worker).not.toHaveProperty('dispatchId');
  });

  it('omits the coordinator when neither the parent nor the run resolves', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('w:1')], {
      configure: (p) => {
        p.workersAt = () => [{ paneKey: 'w:1', runId: 'run_9' }];
        p.scanAt = () => scanOf({ sessionId: 'sw', paneKey: 'w:1' });
      },
    });
    const [worker] = (await readRoster(dir, 'boot-1-runtime-1.json')).entries;
    expect(worker).toMatchObject({ role: 'worker' });
    expect(worker).not.toHaveProperty('coordinatorSessionId');
  });

  it('gives no entry to a non-Claude row, an orphaned terminal or a pane without a terminal', async () => {
    const dir = await tempStateDir();
    const agents = [agent('a:1'), agent('b:2', { agentType: 'codex', agentIdentity: 'codex' }), agent('c:3', { orphaned: true }), agent('d:4', { hasTerminal: false })];
    await rosterRun(dir, agents, { configure: (p) => (p.scanAt = () => scanOf(...['a:1', 'b:2', 'c:3', 'd:4'].map((paneKey, i) => ({ sessionId: `s${i}`, paneKey })))) });
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries.map((e) => e.paneKey)).toEqual(['a:1']);
  });

  it('keeps one entry per session ID: the newest process wins, and equal start times keep the first row', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1'), agent('b:2')], { configure: (p) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1', startTime: 5 }, { sessionId: 's1', paneKey: 'b:2', startTime: 9 })) });
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries.map((e) => e.paneKey)).toEqual(['b:2']);
    await rosterRun(dir, [agent('a:1'), agent('b:2')], { configure: (p) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1', startTime: 5 }, { sessionId: 's1', paneKey: 'b:2', startTime: 5 })) });
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries.map((e) => e.paneKey)).toEqual(['a:1']);
  });

  it('takes the newest scan record when two share a pane key', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1')], { configure: (p) => (p.scanAt = () => scanOf({ sessionId: 'old', paneKey: 'a:1', startTime: 1 }, { sessionId: 'new', paneKey: 'a:1', startTime: 2 })) });
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries.map((e) => e.sessionId)).toEqual(['new']);
  });

  it('gives a scan record without a pane key to no row', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1')], { configure: (p) => (p.scanAt = () => scanOf({ sessionId: 'loose', paneKey: null })) });
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries).toEqual([]);
  });
});

describe('roster files', () => {
  const one = (p: FakeOrca) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1' }));

  it('writes roster/<boot>-<runtime>.json, and none for a null runtime ID', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1')], { configure: one });
    await rosterRun(dir, [agent('a:1')], { configure: (p) => { one(p); p.runtimeIdAt = () => null; } });
    expect(await rosterNames(dir)).toEqual(['boot-1-none.json', 'boot-1-runtime-1.json']);
    expect((await readRoster(dir, 'boot-1-none.json')).runtimeId).toBeNull();
  });

  it('writes the file even when no agent has a session ID', async () => {
    const dir = await tempStateDir();
    const { code, out } = await rosterRun(dir, [agent('a:1')]);
    expect([code, out]).toEqual([0, 'roster saved: 0 agents\n']);
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries).toEqual([]);
  });

  it('replaces the entries of the same runtime, keeps firstSavedAt, and drops an agent that was closed', async () => {
    const dir = await tempStateDir();
    const both = (p: FakeOrca) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1' }, { sessionId: 's2', paneKey: 'b:2' }));
    await rosterRun(dir, [agent('a:1'), agent('b:2')], { configure: both, now: T0 });
    await rosterRun(dir, [agent('a:1')], { configure: both, now: T0 + 60_000 });
    const roster = await readRoster(dir, 'boot-1-runtime-1.json');
    expect(roster.entries.map((e) => e.sessionId)).toEqual(['s1']);
    expect([roster.firstSavedAt, roster.lastSavedAt]).toEqual(['2026-03-01T00:00:00.000Z', '2026-03-01T00:01:00.000Z']);
  });

  it('carries over, unchanged, the entry of a live pane whose session ID the scan missed, and counts it', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1'), agent('b:2')], { configure: (p) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1', permission: BYPASS }, { sessionId: 's2', paneKey: 'b:2' })), now: T0 });
    const { out } = await rosterRun(dir, [agent('a:1'), agent('b:2')], { configure: (p) => (p.scanAt = () => scanOf({ sessionId: 's2', paneKey: 'b:2' })), now: T0 + 60_000 });
    expect(out).toBe('roster saved: 2 agents\n');
    const { entries } = await readRoster(dir, 'boot-1-runtime-1.json');
    expect(entries.map((e) => [e.sessionId, e.savedAt])).toEqual([
      ['s2', '2026-03-01T00:01:00.000Z'],
      ['s1', '2026-03-01T00:00:00.000Z'],
    ]);
    expect(entries[1]).toMatchObject({ permission: BYPASS });
  });

  it('stores the layout title of the tab, only when there is one', async () => {
    const dir = await tempStateDir();
    const both = (p: FakeOrca) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1' }, { sessionId: 's2', paneKey: 'b:2' }));
    await rosterRun(dir, [agent('a:1', { tabTitle: 'My Tab' }), agent('b:2')], { configure: both });
    const { entries } = await readRoster(dir, 'boot-1-runtime-1.json');
    expect(entries[0]).toMatchObject({ sessionId: 's1', title: 'My Tab' });
    expect(entries[1]).not.toHaveProperty('title');
  });

  it('keeps the title of a carried-over entry', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1', { tabTitle: 'Kept Title' })], { configure: (p) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1' })) });
    await rosterRun(dir, [agent('a:1')], { configure: (p) => (p.scanAt = () => scanOf()), now: T0 + 60_000 });
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries).toMatchObject([{ sessionId: 's1', title: 'Kept Title', savedAt: '2026-03-01T00:00:00.000Z' }]);
  });

  it('loads and carries over a roster written without titles', async () => {
    const dir = await tempStateDir();
    const key = { bootId: 'boot-1', runtimeId: 'runtime-1' };
    await mkdir(rosterFolder(dir), { recursive: true });
    await writeFile(join(rosterFolder(dir), 'boot-1-runtime-1.json'), JSON.stringify({ ...key, firstSavedAt: new Date(T0).toISOString(), lastSavedAt: new Date(T0).toISOString(), entries: [{ ...rosterEntry('s1', { paneKey: 'a:1' }) }] }));
    const { code } = await rosterRun(dir, [agent('a:1')], { configure: (p) => (p.scanAt = () => scanOf()), now: T0 + 60_000 });
    expect(code).toBe(0);
    const { entries } = await readRoster(dir, 'boot-1-runtime-1.json');
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('title');
  });

  it('drops a carried entry whose session ID a new entry has', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1')], { configure: (p) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'a:1' })) });
    await rosterRun(dir, [agent('a:1'), agent('b:2')], { configure: (p) => (p.scanAt = () => scanOf({ sessionId: 's1', paneKey: 'b:2' })) });
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries.map((e) => [e.sessionId, e.paneKey])).toEqual([['s1', 'b:2']]);
  });

  it('drops the entry of a pane that is no longer live, even when the scan misses nothing for it', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1')], { configure: one });
    await rosterRun(dir, [agent('b:2')], { configure: (p) => (p.scanAt = () => scanOf()) });
    expect((await readRoster(dir, 'boot-1-runtime-1.json')).entries).toEqual([]);
  });

  it('writes a new runtime or a new boot to a new file and never rewrites an older one', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [agent('a:1')], { configure: one, now: T0 });
    const before = await readRosterText(dir, 'boot-1-runtime-1.json');
    await rosterRun(dir, [], { configure: (p) => (p.runtimeIdAt = () => 'runtime-2'), now: T0 + 60_000 });
    await rosterRun(dir, [], { configure: (p) => (p.boot = 'boot-2'), now: T0 + 120_000 });
    expect(await rosterNames(dir)).toEqual(['boot-1-runtime-1.json', 'boot-1-runtime-2.json', 'boot-2-runtime-1.json']);
    expect(await readRosterText(dir, 'boot-1-runtime-1.json')).toBe(before);
  });

  it('keeps the newest 5 of 6 runtimes', async () => {
    const dir = await tempStateDir();
    for (let i = 1; i <= 6; i++) await rosterRun(dir, [], { configure: (p) => (p.runtimeIdAt = () => `rt-${i}`), now: T0 + i * 60_000 });
    expect(await rosterNames(dir)).toEqual([2, 3, 4, 5, 6].map((i) => `boot-1-rt-${i}.json`));
  });

  it('breaks a tie of last save times by the greater file name', async () => {
    const dir = await tempStateDir();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await rosterRun(dir, [], { configure: (p) => (p.runtimeIdAt = () => id), now: T0 });
    expect(await rosterNames(dir)).toEqual(['b', 'c', 'd', 'e', 'f'].map((id) => `boot-1-${id}.json`));
  });

  it('never removes the file it just wrote, even when its time is the oldest', async () => {
    const dir = await tempStateDir();
    for (let i = 1; i <= 5; i++) await rosterRun(dir, [], { configure: (p) => (p.runtimeIdAt = () => `rt-${i}`), now: T0 + i * 60_000 });
    await rosterRun(dir, [], { configure: (p) => (p.runtimeIdAt = () => 'rt-late'), now: T0 - 60_000 });
    const names = await rosterNames(dir);
    expect(names).toHaveLength(5);
    expect(names).toContain('boot-1-rt-late.json');
    expect(names).not.toContain('boot-1-rt-1.json');
  });

  it('ignores files that do not end in .json', async () => {
    const dir = await tempStateDir();
    await mkdir(rosterFolder(dir), { recursive: true });
    await writeFile(join(rosterFolder(dir), 'boot-0-x.json.9.zzz.tmp'), '{"half":');
    await writeFile(join(rosterFolder(dir), 'notes.txt'), 'x');
    const { code } = await rosterRun(dir, [], {});
    expect(code).toBe(0);
    expect(await rosterNames(dir)).toEqual(['boot-0-x.json.9.zzz.tmp', 'boot-1-runtime-1.json', 'notes.txt']);
  });

  it('keeps an unsafe runtime ID out of the file name and in the file', async () => {
    const dir = await tempStateDir();
    await rosterRun(dir, [], { configure: (p) => (p.runtimeIdAt = () => '../evil/x y') });
    expect(await rosterNames(dir)).toEqual(['boot-1-.._evil_x_y.json']);
    expect((await readRoster(dir, 'boot-1-.._evil_x_y.json')).runtimeId).toBe('../evil/x y');
  });

  it('uses a fresh temporary name for each write', async () => {
    const dir = await tempStateDir();
    let n = 0;
    const storeOptions = { pid: 4242, tmpSuffix: () => `s${n++}` };
    await mkdir(join(rosterFolder(dir), 'boot-1-runtime-1.json.4242.s0.tmp'), { recursive: true });
    expect((await rosterRun(dir, [], { storeOptions })).code).toBe(1);
    expect((await rosterRun(dir, [], { storeOptions })).code).toBe(0);
    expect(await readFile(join(rosterFolder(dir), 'boot-1-runtime-1.json'), 'utf8')).toContain('"bootId"');
  });
});
