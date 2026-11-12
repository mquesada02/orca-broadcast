import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { TerminalSize } from '../src/block.js';
import type { AgentRecord } from '../src/types.js';
import { chunks, CLEAR, roomy } from './helpers/block.js';
import { agentRecord, fakeClock, pausedDone, repliesWithToken, seedOpenRun, startsNewTurnAfterContinue, working, type Behavior, type FakeAgent } from './helpers/fake-orca.js';
import { runCli, type RunCliOptions } from './helpers/run-cli.js';

/** Working until it has the message and `polls` more listings passed, then done with the token line. */
const confirmsAfter = (polls: number): Behavior => {
  let seen = 0;
  const replies = repliesWithToken();
  return (ctx) => {
    if (ctx.received.length === 0) return { state: 'working', message: null };
    seen += 1;
    return seen > polls ? replies(ctx) : { state: 'working', message: null };
  };
};

const agent = (paneKey: string, worktree: string, behavior: Behavior = working, repo = 'repo'): FakeAgent => ({ paneKey, worktree, repo, behavior });

const pause = (agents: FakeAgent[], opts: RunCliOptions = {}, argv: string[] = []) =>
  runCli(['pause', '--yes', '--timeout', '10s', ...argv], agents, { newToken: () => 'abcd1234', isTTY: true, ...opts });

describe('pause on a terminal: the block', () => {
  it('draws the count line and one aligned row per unconfirmed agent, with the reason, sorted', async () => {
    const { err } = await pause([agent('a:1', 'beta'), agent('a:2', 'alpha'), agent('a:3', 'alpha', working, 'aardvark')], { size: roomy });
    expect(chunks(err)[0]).toMatch(
      new RegExp(
        `^\\r\\x1b\\[Jpausing… 0/3 confirmed · 3 still-working · \\d+:\\d{2} left\\n  aardvark/alpha  session  still-working\\n  repo/alpha      session  still-working\\n  repo/beta       session  still-working$`,
      ),
    );
  });

  it('drops an agent from the next block when it is confirmed', async () => {
    const { err } = await pause([agent('a:1', 'alpha', confirmsAfter(1)), agent('a:2', 'beta')], { size: roomy });
    const blocks = chunks(err);
    expect(blocks[0]).toContain('0/2 confirmed');
    expect(blocks[0]).toContain('  repo/alpha  session  still-working\n  repo/beta   session  still-working');
    const second = blocks.find((b) => b.includes('1/2 confirmed')) as string;
    expect(second).toMatch(/^\r\x1b\[2A\x1b\[Jpausing… 1\/2 confirmed · 1 still-working · \d+:\d{2} left\n {2}repo\/beta {2}session {2}still-working$/);
  });

  it('shows no row for an unselected agent or the running session, and counts the same agents', async () => {
    const agents = [agent('a:1', 'alpha'), agent('b:1', 'beta', working, 'other'), agent('s:1', 'self')];
    const { err } = await pause(agents, { size: roomy, env: { ORCA_PANE_KEY: 's:1' }, configure: (port) => { port.repos = [{ id: 'repo-repo', path: '/r/repo', displayName: 'repo' }, { id: 'repo-other', path: '/r/other', displayName: 'other' }]; } }, ['--repo', 'repo']);
    const first = chunks(err)[0] as string;
    expect(first).toContain('0/1 confirmed');
    expect(first).toContain('repo/alpha');
    expect(first).not.toContain('other/beta');
    expect(first).not.toContain('self');
  });

  it('shows no row for a gone agent', async () => {
    const { err } = await pause([agent('a:1', 'alpha'), { ...agent('a:2', 'beta'), hasRow: false }], { size: roomy });
    const first = chunks(err)[0] as string;
    expect(first).toContain('repo/alpha');
    expect(first).not.toContain('repo/beta');
    expect(first).toContain('0/1 confirmed');
  });

  it('clears the block before the report', async () => {
    const { err, out } = await pause([agent('a:1', 'alpha', confirmsAfter(0))], { size: roomy });
    expect(err).toMatch(/1\/1 confirmed · .*\r\x1b\[J$/);
    expect(out).toContain('confirmed');
  });

  it('clears the block before the report after an abort', async () => {
    const signals = new EventEmitter();
    const clock = fakeClock();
    let sleeps = 0;
    clock.onSleep = () => {
      sleeps += 1;
      if (sleeps === 2) signals.emit('SIGINT');
    };
    const { err } = await pause([agent('a:1', 'alpha')], { size: roomy, signals, clock });
    expect(err).toContain('0/1 confirmed');
    expect(err).toMatch(/\x1b\[1A\x1b\[J/);
    expect(chunks(err).at(-1)).toMatch(/^\r\x1b\[1A\x1b\[J(?:orca-broadcast: .*\n)?$/);
  });

  it.each<[string, TerminalSize | undefined]>([
    ['no size', undefined],
    ['a size of 0', { rows: 0, columns: 0 }],
  ])('draws the count line alone with %s', async (_name, size) => {
    const { err } = await pause([agent('a:1', 'alpha')], { size });
    expect(chunks(err)[0]).toMatch(/^\r\x1b\[Jpausing… 0\/1 confirmed/);
    expect(err).not.toContain('repo/alpha');
  });

  it('draws no block without a terminal, and none with --json', async () => {
    expect((await pause([agent('a:1', 'alpha')], { size: roomy, isTTY: false })).err).toBe('');
    expect((await pause([agent('a:1', 'alpha')], { size: roomy }, ['--json'])).err).toBe('');
  });
});

const rec = (paneKey: string, worktree: string, extra: Partial<AgentRecord> = {}): AgentRecord => agentRecord(paneKey, { worktree, role: 'session', ...extra });

const resume = (agents: FakeAgent[], records: AgentRecord[], opts: RunCliOptions = {}, argv: string[] = []) =>
  runCli(['resume', '--yes', ...argv], agents, { isTTY: true, seed: (store) => seedOpenRun(store, records), ...opts });

describe('resume on a terminal: the block', () => {
  it('draws the count line and one row per pending agent', async () => {
    const { err } = await resume([agent('a:1', 'alpha', startsNewTurnAfterContinue), agent('a:2', 'beta', pausedDone())], [rec('a:1', 'alpha'), rec('a:2', 'beta')], { size: roomy });
    expect(chunks(err)[0]).toBe(`${CLEAR}resuming… 0/2 resumed\n  repo/alpha  session\n  repo/beta   session`);
  });

  it('drops an agent from the next block when it is resumed, and never shows a gone agent', async () => {
    const records = [rec('a:1', 'alpha'), rec('a:2', 'beta'), rec('a:3', 'gamma', { resumeStatus: 'gone', resumeReason: 'terminal-closed' })];
    const { err } = await resume([agent('a:1', 'alpha', startsNewTurnAfterContinue), agent('a:2', 'beta', pausedDone())], records, { size: roomy });
    const resumed = chunks(err).find((b) => b.includes('1/2 resumed')) as string;
    expect(resumed).toContain('repo/beta');
    expect(resumed).not.toContain('repo/alpha');
    expect(err).not.toContain('gamma');
  });

  it('clears the block before the report', async () => {
    const { err } = await resume([agent('a:1', 'alpha', startsNewTurnAfterContinue)], [rec('a:1', 'alpha')], { size: roomy });
    expect(err).toMatch(/1\/1 resumed\r\x1b\[J$/);
  });

  it('clears the block before the report after an abort', async () => {
    const signals = new EventEmitter();
    const clock = fakeClock();
    let sleeps = 0;
    clock.onSleep = () => {
      sleeps += 1;
      if (sleeps === 2) signals.emit('SIGINT');
    };
    const { err } = await resume([agent('a:1', 'alpha', pausedDone())], [rec('a:1', 'alpha')], { size: roomy, signals, clock });
    expect(err).toContain('0/1 resumed');
    expect(chunks(err).at(-1)).toMatch(/^\r\x1b\[1A\x1b\[J(?:orca-broadcast: .*\n)?$/);
  });

  it.each<[string, TerminalSize | undefined]>([
    ['no size', undefined],
    ['a size of 0', { rows: 0, columns: 0 }],
  ])('draws the count line alone with %s', async (_name, size) => {
    const { err } = await resume([agent('a:1', 'alpha', startsNewTurnAfterContinue)], [rec('a:1', 'alpha')], { size });
    expect(err).toContain(`${CLEAR}resuming… 0/1 resumed`);
    expect(err).not.toContain('repo/alpha');
  });

  it('shows the reason of a pending agent', async () => {
    const waiting: Behavior = () => ({ state: 'waiting', message: null });
    const { err } = await resume([agent('a:1', 'alpha', waiting)], [rec('a:1', 'alpha')], { size: roomy });
    expect(chunks(err)[0]).toMatch(/^\r\x1b\[Jresuming… 0\/1 resumed\n  repo\/alpha  session  waiting-permission$/);
  });

  it('draws no block without a terminal, and none with --json', async () => {
    const off = await resume([agent('a:1', 'alpha', startsNewTurnAfterContinue)], [rec('a:1', 'alpha')], { size: roomy, isTTY: false });
    expect(off.err).toBe('');
    const json = await resume([agent('a:1', 'alpha', startsNewTurnAfterContinue)], [rec('a:1', 'alpha')], { size: roomy }, ['--json']);
    expect(json.err).toBe('');
  });
});
