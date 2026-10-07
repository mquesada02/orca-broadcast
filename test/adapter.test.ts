import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOrcaAdapter, ExecFailure, type Exec } from '../src/orca-adapter.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8');
const json = (name: string) => JSON.parse(fixture(name));

function fakeExec(responses: Record<string, string | ((args: string[]) => string)>) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    const key = args.slice(0, 2).join(' ');
    const response = responses[key];
    if (response === undefined) throw new Error(`unexpected command ${key}`);
    return { stdout: typeof response === 'function' ? response(args) : response, stderr: '', code: 0 };
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

  it('maps the woken-agent captures: a token reply while working, a null reply mid-turn, a token reply when done', async () => {
    const mapped = async (name: string) => {
      const { exec } = fakeExec({ 'worktree ps': fixture(`worktree-ps-woken-${name}`) });
      return (await createOrcaAdapter(exec).listAgents())[0];
    };

    expect(await mapped('working-token')).toMatchObject({ state: 'working', lastAssistantMessage: expect.stringMatching(/\nORCA-PAUSED 0a1b2c3d$/) });
    expect(await mapped('midturn')).toMatchObject({ state: 'working', lastAssistantMessage: null });
    expect(await mapped('done-token')).toMatchObject({ state: 'done', lastAssistantMessage: expect.stringMatching(/\nORCA-PAUSED 0a1b2c3d$/) });
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

  it('maps the repo, path and parent link of every agent, and a null parent link of a plain handoff child', async () => {
    const { exec } = fakeExec({ 'worktree ps': fixture('worktree-ps') });
    const rows = await createOrcaAdapter(exec).listAgents();
    const worktrees = json('worktree-ps').result.worktrees as any[];
    const withParent = worktrees.find((w) => w.agents?.some((a: any) => a.parentPaneKey));
    const agent = withParent.agents.find((a: any) => a.parentPaneKey);
    expect(rows.find((r) => r.paneKey === agent.paneKey)).toMatchObject({ parentPaneKey: agent.parentPaneKey, repoId: withParent.repoId, path: withParent.path });

    const plain = createOrcaAdapter(fakeExec({ 'worktree ps': fixture('worktree-ps-plain-handoff') }).exec);
    const [child] = await plain.listAgents();
    expect(child).toMatchObject({ parentPaneKey: null, agentType: 'claude' });
    expect(child?.repoId).toBe(json('worktree-ps-plain-handoff').result.worktrees[0].repoId);
  });

  it('maps a run-list row with a null coordinator_handle to a null coordinator handle', async () => {
    const { exec } = fakeExec({ 'orchestration run-list': fixture('run-list-null-handle') });
    const runs = await createOrcaAdapter(exec).listRuns();
    expect(runs.map((r) => r.coordinatorHandle === null)).toEqual([true, false]);
  });

  it('maps worker-list rows to a terminal handle and a run id, and asks for active workers only', async () => {
    const { exec, calls } = fakeExec({ 'orchestration worker-list': fixture('worker-list') });
    const workers = await createOrcaAdapter(exec).listWorkers();
    const source = json('worker-list').result.workers;
    expect(workers).toEqual(source.map((w: any) => ({ handle: w.agentTerminalHandle, runId: w.runId })));
    expect(workers).toHaveLength(3);
    expect(calls[0]?.args).toEqual(['orchestration', 'worker-list', '--terminal-state', 'active', '--json']);
  });

  it('follows the worker-list cursor while hasMore is true', async () => {
    const page1 = json('worker-list-page1');
    const page2 = json('worker-list');
    page2.result.workers = [{ ...page2.result.workers[1], runId: 'run_page_two', agentTerminalHandle: 'term_page_two' }];
    const { exec, calls } = fakeExec({ 'orchestration worker-list': (args) => JSON.stringify(args.includes('--cursor') ? page2 : page1) });
    const workers = await createOrcaAdapter(exec).listWorkers();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(['orchestration', 'worker-list', '--terminal-state', 'active', '--json', '--cursor', page1.result.page.nextCursor]);
    expect(workers.map((w) => w.runId)).toEqual([json('worker-list-page1').result.workers[0].runId, 'run_page_two']);
  });

  it('skips a worker-list row with a null terminal handle, and keeps a row with a null run id', async () => {
    const body = json('worker-list');
    body.result.workers = [
      { ...body.result.workers[0], agentTerminalHandle: null },
      { ...body.result.workers[1], runId: null },
    ];
    const workers = await createOrcaAdapter(fakeExec({ 'orchestration worker-list': JSON.stringify(body) }).exec).listWorkers();
    expect(workers).toEqual([{ handle: body.result.workers[1].agentTerminalHandle, runId: null }]);
  });

  it('fails when worker-list says hasMore with no cursor or the same cursor again', async () => {
    const noCursor = json('worker-list-page1');
    noCursor.result.page.nextCursor = null;
    await expect(createOrcaAdapter(fakeExec({ 'orchestration worker-list': JSON.stringify(noCursor) }).exec).listWorkers()).rejects.toThrow('worker-list paging');
    await expect(createOrcaAdapter(fakeExec({ 'orchestration worker-list': fixture('worker-list-page1') }).exec).listWorkers()).rejects.toThrow('worker-list paging');
  });

  it('maps repo list to id, path and display name', async () => {
    const { exec, calls } = fakeExec({ 'repo list': fixture('repo-list') });
    const repos = await createOrcaAdapter(exec).listRepos();
    const source = json('repo-list').result.repos;
    expect(repos).toEqual(source.map((r: any) => ({ id: r.id, path: r.path, displayName: r.displayName })));
    expect(repos).toHaveLength(2);
    expect(calls[0]?.args).toEqual(['repo', 'list', '--json']);
  });

  it('maps worktree list to id, repo id, path and display name, asking for a large limit', async () => {
    const { exec, calls } = fakeExec({ 'worktree list': fixture('worktree-list') });
    const worktrees = await createOrcaAdapter(exec).listWorktrees();
    const source = json('worktree-list').result.worktrees;
    expect(worktrees).toEqual(source.map((w: any) => ({ id: w.id, repoId: w.repoId, path: w.path, displayName: w.displayName })));
    expect(worktrees).toHaveLength(6);
    expect(calls[0]?.args).toEqual(['worktree', 'list', '--limit', '10000', '--json']);
  });

  it('gives a worktree the same id as worktree ps does: <repoId>::<path>', async () => {
    const fromList = (await createOrcaAdapter(fakeExec({ 'worktree list': fixture('worktree-list') }).exec).listWorktrees())[0];
    const fromPs = (await createOrcaAdapter(fakeExec({ 'worktree ps': fixture('worktree-ps') }).exec).listAgents())[0];
    expect(fromList?.id).toBe(`${fromList?.repoId}::${fromList?.path}`);
    expect(fromPs?.worktreeId).toBe(`${fromPs?.repoId}::${fromPs?.path}`);
  });

  it('keeps the same display name in two repos and leaves archived worktrees out', async () => {
    const worktrees = await createOrcaAdapter(fakeExec({ 'worktree list': fixture('worktree-list') }).exec).listWorktrees();
    expect(worktrees.filter((w) => w.displayName === 'main').map((w) => w.repoId)).toHaveLength(2);
    const doc = json('worktree-list');
    doc.result.worktrees[1].isArchived = true;
    const rest = await createOrcaAdapter(fakeExec({ 'worktree list': JSON.stringify(doc) }).exec).listWorktrees();
    expect(rest).toHaveLength(5);
    expect(rest.map((w) => w.id)).not.toContain(doc.result.worktrees[1].id);
  });

  it('maps a send result to accepted or not accepted', async () => {
    const accepted = fakeExec({ 'terminal send': fixture('terminal-send-accepted') });
    expect(await createOrcaAdapter(accepted.exec).send('term_x', 'hello')).toEqual({ accepted: true });
    expect(accepted.calls[0]?.args).toEqual(['terminal', 'send', '--terminal', 'term_x', '--text', 'hello', '--enter', '--json']);

    const stale = fakeExec({ 'terminal send': fixture('terminal-send-stale') });
    expect(await createOrcaAdapter(stale.exec).send('term_x', 'hello')).toEqual({ accepted: false, reason: 'terminal_handle_stale' });
  });

  it.each([
    ['send.accepted is false', (r: any) => { r.send.accepted = false; }],
    ['send.accepted is not a boolean true', (r: any) => { r.send.accepted = 'true'; }],
    ['the send object is missing', (r: any) => { delete r.send; }],
    ['send is null', (r: any) => { r.send = null; }],
    ['accepted sits at the old result.accepted location', (r: any) => { delete r.send; r.accepted = true; }],
  ])('does not accept a receipt when %s', async (_name, mutate) => {
    const receipt = json('terminal-send-accepted');
    mutate(receipt.result);
    const { exec } = fakeExec({ 'terminal send': JSON.stringify(receipt) });
    expect(await createOrcaAdapter(exec).send('term_x', 'hello')).toEqual({ accepted: false, reason: 'not-accepted' });
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

describe('orca adapter unknown-outcome send', () => {
  const ID = '00000000-0000-4000-8000-000000000037';
  const partial = readFileSync(join(import.meta.dirname, 'fixtures', 'terminal-send-truncated.txt'), 'utf8');

  function sequence(...outcomes: (string | Error)[]) {
    const calls: string[][] = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      const outcome = outcomes[calls.length - 1];
      if (outcome === undefined) throw new Error('unexpected extra call');
      if (outcome instanceof Error) throw outcome;
      return { stdout: outcome, stderr: '', code: 0 };
    };
    return { exec, calls };
  }

  const timeout = (stdout: string, stderr = '') => new ExecFailure(new Error('timed out'), stdout, stderr);

  it('retries once with the reported request id, same terminal and text, no --wait-submit', async () => {
    const { exec, calls } = sequence(timeout(partial), fixture('terminal-send-accepted'));
    expect(await createOrcaAdapter(exec).send('term_x', 'hello')).toEqual({ accepted: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([...calls[0]!, '--retry-request', ID]);
    expect(calls[1]).not.toContain('--wait-submit');
  });

  it('extracts the retry id from the warning text of the real receipt', async () => {
    const receipt = json('terminal-send-accepted');
    const { exec, calls } = sequence(timeout(receipt.result.warnings[0]), fixture('terminal-send-accepted'));
    expect(await createOrcaAdapter(exec).send('term_x', 'hello')).toEqual({ accepted: true });
    expect(calls[1]).toEqual([...calls[0]!, '--retry-request', receipt.result.mutation.requestId]);
  });

  it('finds the id in the error text of unparseable stdout or in stderr', async () => {
    const text = sequence('Terminal prompt request ID: x. Re-issue the exact command with --retry-request abc-123 --wait-submit 5', fixture('terminal-send-accepted'));
    expect(await createOrcaAdapter(text.exec).send('term_x', 'hello')).toEqual({ accepted: true });
    expect(text.calls[1]).toContain('abc-123');
    const err = sequence(timeout('', `--retry-request ${ID}`), fixture('terminal-send-accepted'));
    expect(await createOrcaAdapter(err.exec).send('term_x', 'hello')).toEqual({ accepted: true });
  });

  it('finds the id in stderr when exec resolves with a non-zero exit code', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      return calls.length === 1 ? { stdout: '', stderr: `--retry-request ${ID}`, code: 1 } : { stdout: fixture('terminal-send-accepted'), stderr: '', code: 0 };
    };
    expect(await createOrcaAdapter(exec).send('term_x', 'hello')).toEqual({ accepted: true });
    expect(calls[1]).toContain(ID);
  });

  it('is not accepted when no id was reported, without a retry', async () => {
    const { exec, calls } = sequence(timeout('{"id":"x"'));
    expect(await createOrcaAdapter(exec).send('term_x', 'hello')).toMatchObject({ accepted: false });
    expect(calls).toHaveLength(1);
  });

  it('retries only once when the retry is also unknown', async () => {
    const { exec, calls } = sequence(timeout(partial), timeout(partial));
    expect(await createOrcaAdapter(exec).send('term_x', 'hello')).toMatchObject({ accepted: false });
    expect(calls).toHaveLength(2);
  });

  it('never retries a valid ok:false envelope, even when it carries a request id', async () => {
    const { exec, calls } = sequence(fixture('terminal-send-stale'));
    expect(await createOrcaAdapter(exec).send('term_x', 'hello')).toEqual({ accepted: false, reason: 'terminal_handle_stale' });
    expect(calls).toHaveLength(1);
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

  it('fails on a truncated worktree list (a real page captured with --limit 2) and on an omitted local host', async () => {
    const truncated = fakeExec({ 'worktree list': fixture('worktree-list-truncated') });
    expect(json('worktree-list-truncated').result).toMatchObject({ truncated: true });
    await expect(createOrcaAdapter(truncated.exec).listWorktrees()).rejects.toThrow(/worktree list listing is incomplete/);
    const local = fakeExec({ 'worktree list': withScope('worktree-list', (r) => (r.hostScope.omittedHostIds = ['local'])) });
    await expect(createOrcaAdapter(local.exec).listWorktrees()).rejects.toThrow(/incomplete/);
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
