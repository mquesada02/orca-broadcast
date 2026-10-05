import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOrcaAdapter, type Exec } from '../src/orca-adapter.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8');
const json = (name: string) => JSON.parse(fixture(name));

function fakeExec(responses: Record<string, string | ((args: string[]) => string)>) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    const key = args.slice(0, 2).join(' ');
    const response = responses[key];
    if (response === undefined) throw new Error(`unexpected command ${key}`);
    return { stdout: typeof response === 'function' ? response(args) : response, code: 0 };
  };
  return { exec, calls };
}

describe('orca adapter mapping', () => {
  it('maps worktree ps into one row per agent', async () => {
    const { exec } = fakeExec({ 'worktree ps': fixture('worktree-ps') });
    const rows = await createOrcaAdapter(exec).listAgents();
    const source = json('worktree-ps').result.worktrees.flatMap((w: any) => w.agents ?? []);

    expect(rows).toHaveLength(source.length);
    expect(source.length).toBeGreaterThan(1);
    const states = new Set(rows.map((r) => r.state));
    expect(states).toContain('working');
    expect(states).toContain('done');
    const first = rows[0]!;
    expect(first).toMatchObject({ agentType: 'claude', paneKey: source[0].paneKey, stateStartedAt: source[0].stateStartedAt });
    expect(first.paneKey).toMatch(/^[^:]+:[^:]+$/);
    expect(rows.every((r) => r.lastAssistantMessage === null || typeof r.lastAssistantMessage === 'string')).toBe(true);
  });

  it('maps terminal list and joins to agents by tabId:leafId', async () => {
    const { exec } = fakeExec({ 'worktree ps': fixture('worktree-ps'), 'terminal list': fixture('terminal-list') });
    const port = createOrcaAdapter(exec);
    const [rows, terminals] = await Promise.all([port.listAgents(), port.listTerminals()]);
    const byPane = new Map(terminals.map((t) => [t.paneKey, t]));

    expect(terminals.length).toBeGreaterThan(0);
    expect(terminals[0]).toMatchObject({ orphaned: false });
    expect(terminals[0]?.handle).toMatch(/^term_/);
    for (const row of rows) expect(byPane.get(row.paneKey)?.agentIdentity).toBe('claude');
    expect(terminals.some((t) => t.agentIdentity === null)).toBe(true);
  });

  it('maps run-list and follows nextCursor until it is null', async () => {
    const page1 = json('run-list');
    page1.result.nextCursor = 'cursor-2';
    const page2 = json('run-list');
    page2.result.runs = [{ ...page2.result.runs[0], id: 'run_second_page', coordinator_handle: 'term_second' }];
    page2.result.nextCursor = null;
    const { exec, calls } = fakeExec({
      'orchestration run-list': (args) => JSON.stringify(args.includes('--cursor') ? page2 : page1),
    });

    const runs = await createOrcaAdapter(exec).listRuns();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toContain('cursor-2');
    expect(runs.map((r) => r.id)).toEqual([...json('run-list').result.runs.map((r: any) => r.id), 'run_second_page']);
    expect(runs.at(-1)?.coordinatorHandle).toBe('term_second');
  });

  it('maps a send result to accepted or not accepted', async () => {
    const accepted = fakeExec({ 'terminal send': fixture('terminal-send-accepted') });
    expect(await createOrcaAdapter(accepted.exec).send('term_x', 'hello')).toEqual({ accepted: true });
    expect(accepted.calls[0]?.args).toEqual(['terminal', 'send', '--terminal', 'term_x', '--text', 'hello', '--enter', '--json']);

    const stale = fakeExec({ 'terminal send': fixture('terminal-send-stale') });
    expect(await createOrcaAdapter(stale.exec).send('term_x', 'hello')).toEqual({ accepted: false, reason: 'terminal_handle_stale' });
  });

  it('returns a crashed or invalid send as not accepted instead of throwing', async () => {
    const crash: Exec = async () => {
      throw new Error('spawn orca-ide ENOENT');
    };
    expect(await createOrcaAdapter(crash).send('term_x', 'hello')).toMatchObject({ accepted: false });
    const garbage = fakeExec({ 'terminal send': 'not json' });
    expect(await createOrcaAdapter(garbage.exec).send('term_x', 'hello')).toMatchObject({ accepted: false });
  });
});

describe('orca adapter listing errors', () => {
  const withScope = (name: string, patch: (result: any) => void) => {
    const doc = json(name);
    patch(doc.result);
    return JSON.stringify(doc);
  };

  it('throws on a truncated listing', async () => {
    const { exec } = fakeExec({
      'worktree ps': withScope('worktree-ps', (r) => (r.truncated = true)),
      'terminal list': withScope('terminal-list', (r) => (r.truncated = true)),
    });
    await expect(createOrcaAdapter(exec).listAgents()).rejects.toThrow(/incomplete/);
    await expect(createOrcaAdapter(exec).listTerminals()).rejects.toThrow(/incomplete/);
  });

  it('throws when the local host is omitted but ignores omitted remote hosts', async () => {
    const local = fakeExec({ 'worktree ps': withScope('worktree-ps', (r) => (r.hostScope.omittedHostIds = ['local'])) });
    await expect(createOrcaAdapter(local.exec).listAgents()).rejects.toThrow(/incomplete/);
    const remote = fakeExec({ 'worktree ps': withScope('worktree-ps', (r) => (r.hostScope.omittedHostIds = ['remote-1'])) });
    await expect(createOrcaAdapter(remote.exec).listAgents()).resolves.toBeDefined();
  });

  it('throws on invalid JSON, an ok:false result and a failed command', async () => {
    const bad = fakeExec({ 'worktree ps': 'nope' });
    await expect(createOrcaAdapter(bad.exec).listAgents()).rejects.toThrow(/invalid JSON/);
    const notOk = fakeExec({ 'worktree ps': fixture('terminal-send-stale') });
    await expect(createOrcaAdapter(notOk.exec).listAgents()).rejects.toThrow(/failed/);
    const missing: Exec = async () => {
      throw new Error('spawn orca-ide ENOENT');
    };
    await expect(createOrcaAdapter(missing).listAgents()).rejects.toThrow(/ENOENT/);
  });
});

describe('executable', () => {
  it('only ever runs orca-ide, never bare orca', async () => {
    const { exec, calls } = fakeExec({
      'worktree ps': fixture('worktree-ps'),
      'terminal list': fixture('terminal-list'),
      'orchestration run-list': fixture('run-list'),
      'terminal send': fixture('terminal-send-accepted'),
    });
    const port = createOrcaAdapter(exec);
    await port.listAgents();
    await port.listTerminals();
    await port.listRuns();
    await port.send('term_x', 'hi');

    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.file).toBe('orca-ide');
  });
});
