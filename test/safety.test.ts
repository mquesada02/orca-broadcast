import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentRecord, fakeClock, PAUSED_REPLY, repliesWithToken, seedOpenRun, startsNewTurnAfterContinue, working, type FakeOrca } from './helpers/fake-orca.js';
import { CTRL_C, runCli, type Answer, type RunCliOptions, type Seed } from './helpers/run-cli.js';
import type { AgentRecord } from '../src/types.js';

/** The run files (not the pointer or lock files), by name. */
async function runFiles(dir: string): Promise<Record<string, string>> {
  const stateDir = join(dir, 'orca-pause');
  if (!existsSync(stateDir)) return {};
  const names = (await readdir(stateDir)).filter((name) => name.endsWith('.json') && name !== 'current.json');
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(join(stateDir, name), 'utf8')])));
}

const interrupts: [string, Answer][] = [['SIGTERM', 'SIGTERM'], ['Ctrl-C', CTRL_C]];
const seedAgents = (agents: AgentRecord[]): Seed => (store) => seedOpenRun(store, agents);
const pendingAgent = (paneKey = 'a:1', extra: Partial<AgentRecord> = {}) => agentRecord(paneKey, { pauseBaseline: PAUSED_REPLY, ...extra });

/** Runs the CLI with a seed, and returns the run files from before and after. */
async function runSeeded(argv: string[], agents: Parameters<typeof runCli>[1], opts: RunCliOptions & { seed: Seed }) {
  let before: Record<string, string> = {};
  const seed: Seed = async (store, dir) => {
    await opts.seed(store, dir);
    before = await runFiles(dir);
  };
  const result = await runCli(argv, agents, { ...opts, seed });
  return { ...result, before, after: await runFiles(result.dir) };
}

describe('refusing without a terminal', () => {
  it.each([['pause'], ['resume']])('%s sends nothing, creates no run and exits 2 naming --yes', async (command) => {
    const { code, err, port, dir } = await runCli([command], [{ paneKey: 'a:1', behavior: working }]);
    expect(code).toBe(2);
    expect(err).toContain('--yes');
    expect(err).not.toContain('Usage:');
    expect(port.sends).toEqual([]);
    expect(port.listCalls).toBe(0);
    expect(await runFiles(dir)).toEqual({});
  });

  it.each([['pause'], ['resume']])('%s --json prints the one JSON error object and nothing on stderr', async (command) => {
    const { code, out, err, port } = await runCli([command, '--json'], [{ paneKey: 'a:1', behavior: working }]);
    expect(code).toBe(2);
    expect(err).toBe('');
    expect(JSON.parse(out)).toMatchObject({ command, outcome: 'error', exitCode: 2, run: null, error: expect.stringContaining('--yes') });
    expect(port.sends).toEqual([]);
  });

  it('refuses --json on a terminal too, without asking', async () => {
    const { code, out, questions, port } = await runCli(['pause', '--json'], [{ paneKey: 'a:1', behavior: working }], { isTTY: true, ask: ['y'] });
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ outcome: 'error', error: expect.stringContaining('--yes') });
    expect(questions).toEqual([]);
    expect(port.sends).toEqual([]);
  });

  it('close needs neither a terminal nor --yes', async () => {
    const { code, out } = await runCli(['close']);
    expect(code).toBe(0);
    expect(out).toBe('nothing to close\n');
  });

  it('close --yes is a usage error', async () => {
    const { code, err } = await runCli(['close', '--yes']);
    expect(code).toBe(2);
    expect(err).toContain('--yes applies only to pause and resume');
    expect(err).toContain('Usage:');
  });

  it('--help documents --yes and wins over it', async () => {
    const { code, out } = await runCli(['--help', '--yes']);
    expect(code).toBe(0);
    expect(out).toContain('--yes');
  });
});

describe('--yes', () => {
  it('skips the prompt on a terminal and sends', async () => {
    const { code, questions, port } = await runCli(['pause', '--yes'], [{ paneKey: 'a:1', behavior: repliesWithToken() }], { isTTY: true, ask: ['n'] });
    expect(code).toBe(0);
    expect(questions).toEqual([]);
    expect(port.sends).toHaveLength(1);
  });
});

describe('the prompt on pause', () => {
  it.each([['n'], [''], ['maybe'], ['yess']])('answer "%s" sends nothing, creates no run and exits 2', async (answer) => {
    const { code, err, port, questions, dir } = await runCli(['pause'], [{ paneKey: 'a:1', behavior: working }], { isTTY: true, ask: [answer] });
    expect(code).toBe(2);
    expect(err).toContain('cancelled: nothing was sent');
    expect(questions).toHaveLength(1);
    expect(port.sends).toEqual([]);
    expect(await runFiles(dir)).toEqual({});
  });

  it.each([['y'], ['YES'], [' Yes ']])('answer "%s" proceeds', async (answer) => {
    const { code, port } = await runCli(['pause'], [{ paneKey: 'a:1', behavior: repliesWithToken() }], { isTTY: true, ask: [answer] });
    expect(code).toBe(0);
    expect(port.sends).toHaveLength(1);
  });

  it('lists repo, worktree and role of each target, then asks with the count', async () => {
    const agents = [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a', behavior: repliesWithToken() },
      { paneKey: 'b:2', repo: 'beta', worktree: 'wt-b', behavior: repliesWithToken() },
    ];
    const { err, questions } = await runCli(['pause'], agents, { isTTY: true, ask: ['y'], configure: (port: FakeOrca) => (port.coordinatorsAt = () => ['a:1']) });
    expect(err).toContain('  alpha/wt-a (coordinator)\n');
    expect(err).toContain('  beta/wt-b (worker)\n');
    expect(err.indexOf('alpha/wt-a')).toBeLessThan(err.indexOf('beta/wt-b'));
    expect(questions).toEqual(['Send to 2 agents? [y/N] ']);
  });

  it('says "1 agent" for one target', async () => {
    const { questions } = await runCli(['pause'], [{ paneKey: 'a:1', behavior: repliesWithToken() }], { isTTY: true, ask: ['y'] });
    expect(questions).toEqual(['Send to 1 agent? [y/N] ']);
  });

  it('with nothing to pause there is no prompt', async () => {
    const { code, out, questions } = await runCli(['pause'], [], { isTTY: true, ask: ['y'] });
    expect(code).toBe(0);
    expect(out).toBe('nothing to pause\n');
    expect(questions).toEqual([]);
  });

  it('a coordinator-read failure while planning exits 2 with nothing sent and no run', async () => {
    const { code, port, questions, dir } = await runCli(['pause'], [{ paneKey: 'a:1', behavior: working }], { isTTY: true, ask: ['y'], configure: (port) => (port.failRunListsFrom = 1) });
    expect(code).toBe(2);
    expect(questions).toEqual([]);
    expect(port.sends).toEqual([]);
    expect(await runFiles(dir)).toEqual({});
  });

  it('a new run whose agents cannot be located is created as without a prompt', async () => {
    const { code, questions, port, dir } = await runCli(['pause'], [{ paneKey: 'a:1', hasTerminal: false, behavior: working }], { isTTY: true, ask: ['n'] });
    expect(code).toBe(1);
    expect(questions).toEqual([]);
    expect(port.sends).toEqual([]);
    expect(Object.keys(await runFiles(dir))).toHaveLength(1);
  });
});

describe('the plan of an extended pause', () => {
  const confirmedA = () => pendingAgent('a:1', { pauseStatus: 'confirmed' });

  it('a new working agent is listed and a "no" leaves the run file byte-identical', async () => {
    const agents = [
      { paneKey: 'a:1', behavior: () => ({ state: 'done', message: PAUSED_REPLY }) },
      { paneKey: 'b:2', worktree: 'wt-b', behavior: working },
    ];
    const { code, err, port, before, after } = await runSeeded(['pause'], agents, { isTTY: true, ask: ['n'], seed: seedAgents([confirmedA()]) });
    expect(code).toBe(2);
    expect(err).toContain('repo/wt-b (worker)');
    expect(port.sends).toEqual([]);
    expect(Object.keys(before)).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it('a woken confirmed agent is listed', async () => {
    const { questions, err, port } = await runCli(['pause'], [{ paneKey: 'a:1', worktree: 'wt-a', behavior: working }], { isTTY: true, ask: ['n'], seed: seedAgents([confirmedA()]) });
    expect(err).toContain('repo/tree-a:1 (worker)');
    expect(questions).toHaveLength(1);
    expect(port.sends).toEqual([]);
  });

  it('a late starter that appears during the prompt is covered by the one confirmation', async () => {
    let answered = false;
    const agents = [
      { paneKey: 'a:1', behavior: repliesWithToken() },
      { paneKey: 'b:2', behavior: () => (answered ? { state: 'working', message: null } : { state: 'done', message: 'x' }) },
    ];
    const { questions, port } = await runCli(['pause', '--timeout', '10s'], agents, { isTTY: true, ask: [() => ((answered = true), 'y')] });
    expect(questions).toHaveLength(1);
    expect(port.sendsTo('b:2')).toBe(1);
  });

  it('counts --timeout from the answer', async () => {
    const clock = fakeClock();
    const { code } = await runCli(['pause', '--timeout', '30s'], [{ paneKey: 'a:1', behavior: working }], { isTTY: true, clock, ask: [() => ((clock.slept += 400_000), 'y')] });
    expect(code).toBe(1);
    expect(clock.slept).toBeGreaterThanOrEqual(400_000 + 30_000);
  });

  describe('when the first plan is empty', () => {
    // a:1 is unconfirmed and already messaged, so nothing is sent at first; b:2 starts working from the third listing.
    const waitingA = () => pendingAgent('a:1', { pauseStatus: 'unconfirmed', pauseReason: 'still-working', messagePending: false });
    const agents = [
      { paneKey: 'a:1', behavior: working },
      { paneKey: 'b:2', behavior: ({ listCalls }: { listCalls: number }) => (listCalls >= 3 ? { state: 'working', message: null } : { state: 'done', message: 'x' }) },
    ];

    it('asks before the late starter is messaged, once, and proceeds on yes', async () => {
      const { code, questions, port } = await runCli(['pause', '--timeout', '10s'], agents, { isTTY: true, ask: ['y'], seed: seedAgents([waitingA()]) });
      expect(code).toBe(1);
      expect(questions).toHaveLength(1);
      expect(port.sendsTo('b:2')).toBe(1);
    });

    it('a "no" sends nothing, exits 2 and restores the original run file', async () => {
      const { code, port, questions, before, after } = await runSeeded(['pause', '--timeout', '10s'], agents, { isTTY: true, ask: ['n'], seed: seedAgents([waitingA()]) });
      expect(code).toBe(2);
      expect(questions).toHaveLength(1);
      expect(port.sends).toEqual([]);
      expect(after).toEqual(before);
    });

    it('asks once for several late starters and lists the coordinator role', async () => {
      const late = (from: number) => ({ listCalls }: { listCalls: number }) => (listCalls >= from ? { state: 'working', message: null } : { state: 'done', message: 'x' });
      const several = [agents[0]!, { paneKey: 'b:2', behavior: late(3) }, { paneKey: 'c:3', behavior: late(4) }];
      const { err, questions, port } = await runCli(['pause', '--timeout', '10s'], several, {
        isTTY: true,
        ask: ['y'],
        seed: seedAgents([waitingA()]),
        configure: (p) => (p.coordinatorsAt = () => ['b:2']),
      });
      expect(questions).toHaveLength(1);
      expect(err).toContain('repo/tree-b:2 (coordinator)');
      expect(port.sendsTo('b:2')).toBe(1);
      expect(port.sendsTo('c:3')).toBe(1);
    });

    it.each(interrupts)('%s at the late prompt exits 130 and restores the original run file', async (_name, answer) => {
      const { code, port, before, after } = await runSeeded(['pause', '--timeout', '10s'], agents, { isTTY: true, signals: new EventEmitter(), ask: [answer], seed: seedAgents([waitingA()]) });
      expect(code).toBe(130);
      expect(port.sends).toEqual([]);
      expect(after).toEqual(before);
    });
  });
});

describe('signals at the first prompt', () => {
  it('SIGTERM exits 130, sends nothing and creates no run', async () => {
    const { code, port, dir } = await runCli(['pause'], [{ paneKey: 'a:1', behavior: working }], { isTTY: true, signals: new EventEmitter(), ask: ['SIGTERM'] });
    expect(code).toBe(130);
    expect(port.sends).toEqual([]);
    expect(await runFiles(dir)).toEqual({});
  });

  it('Ctrl-C exits 130 like a signal, not 2 like a "no"', async () => {
    const { code, port, dir } = await runCli(['pause'], [{ paneKey: 'a:1', behavior: working }], { isTTY: true, ask: [CTRL_C] });
    expect(code).toBe(130);
    expect(port.sends).toEqual([]);
    expect(await runFiles(dir)).toEqual({});
  });
});

describe('the prompt on resume', () => {
  const seed = seedAgents([pendingAgent('a:1', { repo: 'alpha', worktree: 'wt-a' })]);

  it('a "no" sends nothing, exits 2 and leaves the run file unchanged', async () => {
    const { code, err, port, questions, before, after } = await runSeeded(['resume'], [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }], { isTTY: true, ask: ['n'], seed });
    expect(code).toBe(2);
    expect(err).toContain('alpha/wt-a (worker)');
    expect(questions).toEqual(['Send to 1 agent? [y/N] ']);
    expect(port.sends).toEqual([]);
    expect(after).toEqual(before);
  });

  it('a "yes" resumes', async () => {
    const { code, port } = await runCli(['resume'], [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }], { isTTY: true, ask: ['y'], seed });
    expect(code).toBe(0);
    expect(port.sends).toHaveLength(1);
  });

  it('with no agent to message there is no prompt', async () => {
    const { questions, code } = await runCli(['resume'], [{ paneKey: 'a:1', behavior: () => ({ state: 'waiting', message: 'x' }) }], { isTTY: true, ask: ['y'], seed });
    expect(questions).toEqual([]);
    expect(code).toBe(1);
  });

  it('an agent that went to waiting while the prompt was open is not messaged', async () => {
    let answered = false;
    const behavior = (ctx: Parameters<typeof startsNewTurnAfterContinue>[0]) => (answered ? { state: 'waiting', message: 'x' } : startsNewTurnAfterContinue(ctx));
    const { port, code } = await runCli(['resume'], [{ paneKey: 'a:1', behavior }], { isTTY: true, ask: [() => ((answered = true), 'y')], seed });
    expect(port.sends).toEqual([]);
    expect(code).toBe(1);
  });

  it.each(interrupts)('%s at the prompt exits 130 and leaves the run file unchanged', async (_name, answer) => {
    const { code, port, before, after } = await runSeeded(['resume'], [{ paneKey: 'a:1', behavior: startsNewTurnAfterContinue }], { isTTY: true, signals: new EventEmitter(), ask: [answer], seed });
    expect(code).toBe(130);
    expect(port.sends).toEqual([]);
    expect(after).toEqual(before);
  });
});
