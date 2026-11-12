import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { TerminalSize } from '../src/block.js';
import type { BroadcastTarget } from '../src/types.js';
import { broadcastTarget, fakeClock, openBroadcastRecord, working, type Behavior, type FakeAgent } from './helpers/fake-orca.js';
import { runCli, type RunCliOptions, type Seed } from './helpers/run-cli.js';

const TOKEN = 'abcd1234';
const ACK = `ORCA-ACK ${TOKEN}`;

/** Working until it has the message and `polls` more listings passed, then done with the ack line. */
const acksAfter = (polls: number): Behavior => {
  let seen = 0;
  return ({ received }) => {
    if (received.length === 0) return { state: 'working', message: null };
    seen += 1;
    return seen > polls ? { state: 'done', message: `Handled it.\n${ACK}` } : { state: 'working', message: null };
  };
};

const agent = (paneKey: string, worktree: string, behavior: Behavior = working, repo = 'repo'): FakeAgent => ({ paneKey, worktree, repo, behavior });

const seedBroadcast = (targets: BroadcastTarget[]): Seed => async (store) => {
  const record = openBroadcastRecord(targets);
  await store.saveBroadcast(record);
  await store.setCurrent('broadcast', record.id);
};

const CLEAR ='\r\x1b[J';
const roomy: TerminalSize = { rows: 30, columns: 100 };

const send = (agents: FakeAgent[], opts: RunCliOptions = {}, argv: string[] = []) =>
  runCli(['broadcast', 'hello', '--yes', '--timeout', '10s', ...argv], agents, { newToken: () => TOKEN, isTTY: true, ...opts });

/** The blocks that were drawn: every chunk of stderr that starts a redraw, cut at the next redraw or at the final clear. */
const chunks = (err: string): string[] => err.split(/(?=\r(?:\x1b\[\d+A)?\x1b\[J)/).filter((c) => c !== '');

describe('broadcast on a terminal: the block', () => {
  it('draws the count line and one aligned row per pending target, with the reason, sorted by repo, worktree, role', async () => {
    const { err } = await send([agent('a:1', 'beta'), agent('a:2', 'alpha'), agent('a:3', 'alpha', working, 'aardvark')], { size: roomy });
    const first = chunks(err)[0];
    expect(first).toBe(`${CLEAR}broadcasting… 0/3 acked\n  aardvark/alpha  session  still-working\n  repo/alpha      session  still-working\n  repo/beta       session  still-working`);
  });

  it('drops a target from the next block after it acks, and the cursor goes up by the lines of the previous block minus one', async () => {
    const { err } = await send([agent('a:1', 'alpha', acksAfter(1)), agent('a:2', 'beta')], { size: roomy });
    const blocks = chunks(err);
    expect(blocks[0]).toContain('0/2 acked\n  repo/alpha  session  still-working\n  repo/beta   session  still-working');
    const second = blocks.find((b) => b.includes('1/2 acked')) as string;
    expect(second).toBe('\r\x1b[2A\x1b[Jbroadcasting… 1/2 acked\n  repo/beta  session  still-working');
  });

  it('clears the block before the report', async () => {
    const { err, out, code } = await send([agent('a:1', 'alpha', acksAfter(0))], { size: roomy });
    expect(code).toBe(0);
    expect(err).toMatch(/broadcasting… 1\/1 acked\r\x1b\[J$/);
    expect(out).toContain('acked');
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('clears the block before the report after %s', async (signal) => {
    const signals = new EventEmitter();
    const clock = fakeClock();
    let sleeps = 0;
    clock.onSleep = () => {
      sleeps += 1;
      if (sleeps === 2) signals.emit(signal);
    };
    const { err, out, code } = await send([agent('a:1', 'alpha')], { size: roomy, signals, clock });
    expect(code).not.toBe(0);
    expect(err).toContain('0/1 acked\n  repo/alpha  session  still-working');
    expect(err).toMatch(/\x1b\[1A\x1b\[Jorca-broadcast: interrupted by [A-Z]+\n$/);
    expect(out).toBe('');
  });

  it('shows `… and N more` on a short terminal', async () => {
    const agents = ['a', 'b', 'c', 'd', 'e'].map((n) => agent(`p:${n}`, n));
    const { err } = await send(agents, { size: { rows: 5, columns: 100 } });
    expect(chunks(err)[0]).toBe(`${CLEAR}broadcasting… 0/5 acked\n  repo/a  session  still-working\n  repo/b  session  still-working\n  … and 3 more`);
  });

  it('cuts every line to columns - 1', async () => {
    const { err } = await send([agent('a:1', 'alpha')], { size: { rows: 30, columns: 20 } });
    expect(chunks(err)[0]).toBe(`${CLEAR}broadcasting… 0/1 a\n  repo/alpha  sessi`);
  });

  it('uses the new size at the next draw', async () => {
    const agents = ['a', 'b', 'c', 'd'].map((n) => agent(`p:${n}`, n));
    const { err } = await send(agents, { size: (read) => (read === 0 ? roomy : { rows: 5, columns: 100 }) });
    const blocks = chunks(err);
    expect(blocks[0]).toContain('  repo/d  session  still-working');
    expect(blocks[1]).toBe('\r\x1b[4A\x1b[Jbroadcasting… 0/4 acked\n  repo/a  session  still-working\n  repo/b  session  still-working\n  … and 2 more');
  });

  it.each<[string, TerminalSize | undefined]>([
    ['3 lines (rows 3)', { rows: 3, columns: 100 }],
    ['rows 0', { rows: 0, columns: 100 }],
    ['columns 0', { rows: 30, columns: 0 }],
    ['a size of 0', { rows: 0, columns: 0 }],
    ['no size', undefined],
  ])('draws the count line alone with %s', async (_name, size) => {
    const { err } = await send([agent('a:1', 'alpha')], { size });
    for (const block of chunks(err)) expect(block).not.toContain('repo/alpha');
    expect(chunks(err)[0]).toContain('broadcasting… 0/1 acked');
  });

  it('draws no block without a terminal', async () => {
    const { err } = await send([agent('a:1', 'alpha')], { size: roomy, isTTY: false });
    expect(err).toBe('');
  });

  it('draws no block with --json on a terminal', async () => {
    const { err } = await send([agent('a:1', 'alpha')], { size: roomy }, ['--json']);
    expect(err).toBe('');
  });

  it('leaves a confirm prompt without block text', async () => {
    const { questions, err } = await runCli(['broadcast', 'hello', '--timeout', '10s'], [agent('a:1', 'alpha')], { newToken: () => TOKEN, isTTY: true, size: roomy, ask: ['n'] });
    expect(questions).toHaveLength(1);
    expect(err.startsWith(CLEAR)).toBe(true);
    expect(err).toContain('  repo/alpha (session)\n');
    expect(err).not.toContain('broadcasting…');
    expect(err).not.toContain('still-working');
  });

  it('shows no row for a target outside the filter scope', async () => {
    const { err } = await send([agent('a:1', 'alpha'), agent('a:2', 'beta')], { size: roomy }, ['--worktree', 'alpha']);
    expect(chunks(err)[0]).toBe(`${CLEAR}broadcasting… 0/1 acked\n  repo/alpha  session  still-working`);
  });

  it('shows no row for the running session', async () => {
    const { err } = await send([agent('a:1', 'alpha'), agent('a:2', 'beta')], { size: roomy, env: { ORCA_PANE_KEY: 'a:2' } });
    expect(chunks(err)[0]).toBe(`${CLEAR}broadcasting… 0/1 acked\n  repo/alpha  session  still-working`);
  });

  it('shows the pending targets of a re-run of an open broadcast', async () => {
    const targets = [broadcastTarget('a:1', { worktree: 'alpha' }), broadcastTarget('a:2', { worktree: 'beta', status: 'acked', reason: null })];
    const { err } = await runCli(['broadcast', '--yes', '--timeout', '10s'], [agent('a:1', 'alpha'), agent('a:2', 'beta')], { newToken: () => TOKEN, isTTY: true, size: roomy, seed: seedBroadcast(targets) });
    expect(chunks(err)[0]).toBe(`${CLEAR}broadcasting… 1/2 acked\n  repo/alpha  session  still-working`);
  });
});
