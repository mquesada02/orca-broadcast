import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { main, parseTimeout, resolveStateDir } from '../src/cli.js';
import { fakeClock, FakeOrca, repliesWithToken, tempStateDir, working } from './helpers/fake-orca.js';

async function run(argv: string[], agents: ConstructorParameters<typeof FakeOrca>[0] = [], isTTY = false) {
  const dir = await tempStateDir();
  const out: string[] = [];
  const err: string[] = [];
  const port = new FakeOrca(agents);
  const clock = fakeClock();
  const code = await main(argv, { XDG_STATE_HOME: dir }, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY }, { port, clock });
  return { code, out: out.join(''), err: err.join(''), dir, port, clock };
}

describe('orca-pause --help and usage', () => {
  it('prints usage and exits 0 for --help', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('Usage: orca-pause pause');
    expect(out).toContain('--timeout');
  });

  it.each([
    [[], 'missing command'],
    [['resume'], 'unknown command'],
    [['pause', 'extra'], 'unknown command'],
    [['pause', '--bogus'], 'bogus'],
    [['pause', '--timeout', '0s'], 'invalid --timeout'],
    [['pause', '--timeout', '10'], 'invalid --timeout'],
    [['pause', '--timeout', '1.5m'], 'invalid --timeout'],
    [['pause', '--timeout', '-5s'], 'timeout'],
  ])('exits 2 for %j without calling Orca', async (argv, message) => {
    const { code, err, port } = await run(argv as string[], [{ paneKey: 'a:1', behavior: working }]);
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(port.listCalls).toBe(0);
    expect(port.sends).toHaveLength(0);
  });
});

describe('parseTimeout', () => {
  it.each([
    ['90s', 90_000],
    ['3m', 180_000],
    ['2h', 7_200_000],
  ])('parses %s', (value, ms) => expect(parseTimeout(value)).toBe(ms));
});

describe('resolveStateDir', () => {
  it('uses XDG_STATE_HOME when set and the home default otherwise', () => {
    expect(resolveStateDir({ XDG_STATE_HOME: '/x/state' }, '/home/u')).toBe('/x/state/orca-pause');
    expect(resolveStateDir({}, '/home/u')).toBe('/home/u/.local/state/orca-pause');
  });
});

describe('orca-pause pause', () => {
  it('exits 0 and prints a confirmed table when every agent pauses', async () => {
    const { code, out, dir } = await run(['pause'], [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a', behavior: repliesWithToken() },
      { paneKey: 'b:2', repo: 'beta', worktree: 'wt-b', behavior: repliesWithToken() },
    ]);
    expect(code).toBe(0);
    expect(out).toContain('confirmed (2)');
    expect(out).toMatch(/alpha\s+wt-a\s+worker\s+confirmed/);
    expect(out).not.toContain('unconfirmed');
    expect((await readdir(`${dir}/orca-pause`)).sort()).toHaveLength(2);
  });

  it('exits 1 and lists unconfirmed agents first with an action hint', async () => {
    const { code, out } = await run(['pause', '--timeout', '10s'], [
      { paneKey: 'a:1', repo: 'alpha', worktree: 'wt-a', behavior: repliesWithToken() },
      { paneKey: 'b:2', repo: 'beta', worktree: 'wt-b', behavior: working },
    ]);
    expect(code).toBe(1);
    expect(out.indexOf('unconfirmed (1)')).toBeLessThan(out.indexOf('confirmed (1)'));
    expect(out).toContain('check these agents before you leave');
    expect(out).toMatch(/beta\s+wt-b\s+worker\s+unconfirmed\s+still-working/);
  });

  it('honours --timeout', async () => {
    const { clock } = await run(['pause', '--timeout', '30s'], [{ paneKey: 'a:1', behavior: working }]);
    expect(clock.slept).toBeGreaterThanOrEqual(30_000);
    expect(clock.slept).toBeLessThan(40_000);
  });

  it('prints nothing to pause and exits 0', async () => {
    const { code, out } = await run(['pause'], [{ paneKey: 'a:1', behavior: () => ({ state: 'done', message: 'x' }) }]);
    expect(code).toBe(0);
    expect(out).toBe('nothing to pause\n');
  });

  it('prints an Orca error to stderr and exits 2', async () => {
    const dir = await tempStateDir();
    const err: string[] = [];
    const port = new FakeOrca([{ paneKey: 'a:1', behavior: working }]);
    port.listError = new Error('orca-ide worktree ps failed: boom');
    const code = await main(['pause'], { XDG_STATE_HOME: dir }, { stdout: () => {}, stderr: (t) => err.push(t), isTTY: false }, { port, clock: fakeClock() });
    expect(code).toBe(2);
    expect(err.join('')).toContain('boom');
  });

  it('shows an in-place progress line on a TTY and none otherwise', async () => {
    const tty = await run(['pause', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: working }], true);
    expect(tty.err).toMatch(/\r\x1b\[Kpausing… 0\/1 confirmed · 1 still-working · \d+:\d{2} left/);
    const plain = await run(['pause', '--timeout', '10s'], [{ paneKey: 'a:1', behavior: working }], false);
    expect(plain.err).toBe('');
  });
});
