import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Interrupted } from '../src/abort.js';
import { HANDOVER_TIMEOUT_MS } from '../src/guard.js';
import { createRecordStore } from '../src/store.js';
import type { BroadcastRecord } from '../src/types.js';
import { agentRecord, broadcastTarget, fakeClock, openBroadcastRecord, repliesWithToken, seedOpenRun, working, type FakeAgent } from './helpers/fake-orca.js';
import { CTRL_C, runCli, seedGroups, type RunCliOptions } from './helpers/run-cli.js';

// The "broadcast process" is a fake pid that holds the lock and is named by the open record. Nothing here signals a real process.
const BROADCAST_PID = 4242;
const START = '777';
const TOKEN = 'abcd1234';
const newToken = () => TOKEN;

type KillMode = 'stops' | 'already-gone' | 'eperm' | 'ignored' | 'other-holder';

interface Scenario {
  /** Start time written in the lock by the broadcast process (undefined: none). */
  lockStart?: string;
  /** Start time written in the open record. */
  recordStart?: string;
  /** What the OS says about the pid now: its start time, or null when the process is dead. */
  aliveStart?: string | null;
  killMode?: KillMode;
  /** The lock holder is not a broadcast: no record names it. */
  noRecord?: boolean;
  pending?: boolean;
}

function scenario(s: Scenario = {}) {
  // An explicit undefined means "no start time", so the defaults cannot be destructuring defaults.
  const lockStart = 'lockStart' in s ? s.lockStart : START;
  const recordStart = 'recordStart' in s ? s.recordStart : START;
  const { aliveStart = START, killMode = 'stops' } = s;
  const kills: [number, NodeJS.Signals][] = [];
  const starts = new Map<number, string | null>([[BROADCAST_PID, aliveStart]]);
  let dir = '';
  const lockPath = () => join(dir, 'lock');
  const recordPath = () => join(dir, 'broadcasts', 'b-1.json');
  // What the broadcast does on SIGTERM: save its record without a pid and release the lock.
  const stopBroadcast = () => {
    const record = JSON.parse(readFileSync(recordPath(), 'utf8')) as BroadcastRecord;
    delete record.pid;
    delete record.startTime;
    writeFileSync(recordPath(), `${JSON.stringify(record)}\n`);
    rmSync(lockPath(), { force: true });
  };
  const opts: RunCliOptions = {
    newToken,
    seed: async (_store, stateHome) => {
      dir = join(stateHome, 'orca-broadcast');
      const broadcastStore = createRecordStore(dir, { pid: BROADCAST_PID, readStartTime: () => lockStart });
      await broadcastStore.acquireLock();
      if (s.noRecord) return;
      const record = openBroadcastRecord([broadcastTarget('a:1', s.pending === false ? { status: 'acked', reason: null } : {})], { pid: BROADCAST_PID, ...(recordStart === undefined ? {} : { startTime: recordStart }) });
      await broadcastStore.saveBroadcast(record);
      await broadcastStore.setCurrent('broadcast', record.id);
    },
    storeOptions: {
      isAlive: (pid) => starts.get(pid) !== null,
      readStartTime: (pid) => starts.get(pid) ?? undefined,
    },
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      if (killMode === 'stops') stopBroadcast();
      if (killMode === 'already-gone') {
        stopBroadcast();
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      if (killMode === 'eperm') throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      if (killMode === 'other-holder') {
        starts.set(5555, '1');
        writeFileSync(lockPath(), '5555 1\n');
      }
    },
  };
  return {
    opts,
    kills,
    record: () => JSON.parse(readFileSync(recordPath(), 'utf8')) as BroadcastRecord,
    files: () => readdirSync(dir),
    pauseRuns: () => (readdirSync(dir).includes('pauses') ? readdirSync(join(dir, 'pauses')) : []),
    pointer: () => (readdirSync(dir).includes('current') ? JSON.parse(readFileSync(join(dir, 'current'), 'utf8')) : null),
  };
}

const worker = (paneKey = 'a:1'): FakeAgent => ({ paneKey, behavior: repliesWithToken() });

describe('pause stops a waiting broadcast', () => {
  it('sends SIGTERM to the proven process, then pauses and abandons the broadcast at the commit point', async () => {
    const world = scenario();
    const { code, err, port } = await runCli(['pause', '--yes'], [worker()], world.opts);
    expect(code).toBe(0);
    expect(world.kills).toEqual([[BROADCAST_PID, 'SIGTERM']]);
    expect(world.record()).toMatchObject({ status: 'closed' });
    expect(world.record()).not.toHaveProperty('pid');
    expect(world.record().targets[0]).toMatchObject({ status: 'abandoned', reason: 'paused' });
    expect(world.pauseRuns()).toHaveLength(1);
    expect(world.pointer()).toMatchObject({ kind: 'pause' });
    expect(err).toContain('broadcast b-1 was closed by this pause: 1 agent had not acknowledged it and will not be waited for');
    expect(port.sends).toHaveLength(1);
    expect(port.sends[0]?.text).toContain('ORCA-PAUSED');
  });

  it('leaves the acked targets as they are and counts only the unacked ones in the warning', async () => {
    const world = scenario({ pending: false });
    const { err } = await runCli(['pause', '--yes'], [worker()], world.opts);
    expect(world.record().targets[0]).toMatchObject({ status: 'acked' });
    expect(err).toContain('0 agents had not acknowledged it');
  });

  it('keeps the warning out of --json', async () => {
    const world = scenario();
    const { out, err } = await runCli(['pause', '--yes', '--json'], [worker()], world.opts);
    expect(JSON.parse(out)).toMatchObject({ command: 'pause', outcome: 'done', exitCode: 0 });
    expect(err).toBe('');
  });

  it('does not signal a reused pid: the lock is stale, so pause takes it over and abandons the record', async () => {
    const world = scenario({ aliveStart: '999' });
    const { code } = await runCli(['pause', '--yes'], [worker()], world.opts);
    expect(code).toBe(0);
    expect(world.kills).toEqual([]);
    expect(world.record()).toMatchObject({ status: 'closed' });
    expect(world.record().targets[0]).toMatchObject({ status: 'abandoned', reason: 'paused' });
  });

  it('does the same when the broadcast died without saving (a dead pid)', async () => {
    const world = scenario({ aliveStart: null });
    const { code } = await runCli(['pause', '--yes'], [worker()], world.opts);
    expect(code).toBe(0);
    expect(world.kills).toEqual([]);
    expect(world.record().targets[0]).toMatchObject({ status: 'abandoned', reason: 'paused' });
  });

  it.each<[string, Scenario]>([
    ['the lock owner start time differs from the record start time', { lockStart: '555', aliveStart: '555' }],
    ['the lock has no start time', { lockStart: undefined, recordStart: START }],
    ['the record has no start time', { recordStart: undefined }],
  ])('fails at once with no signal when %s', async (_name, s) => {
    const world = scenario(s);
    const { code, err, port } = await runCli(['pause', '--yes'], [worker()], world.opts);
    expect(code).toBe(2);
    expect(err).toContain('another orca-broadcast is running');
    expect(world.kills).toEqual([]);
    expect(port.sends).toEqual([]);
    expect(world.pauseRuns()).toEqual([]);
    expect(world.record()).toMatchObject({ status: 'open', pid: BROADCAST_PID });
  });

  it('does not hand over when a pause run is open beside the broadcast: the lock error stands and nothing is signalled', async () => {
    const world = scenario();
    const seed = world.opts.seed;
    const { code, err } = await runCli(['pause', '--yes'], [worker()], {
      ...world.opts,
      seed: async (store, dir) => {
        await seed?.(store, dir);
        await seedOpenRun(store, [agentRecord('a:1')]);
      },
    });
    expect(code).toBe(2);
    expect(err).toContain('another orca-broadcast is running');
    expect(world.kills).toEqual([]);
  });

  it('fails at once with no signal when the lock holder is not a broadcast (no open record)', async () => {
    const world = scenario({ noRecord: true });
    const { code, err } = await runCli(['pause', '--yes'], [worker()], world.opts);
    expect(code).toBe(2);
    expect(err).toContain('another orca-broadcast is running');
    expect(world.kills).toEqual([]);
  });

  it.each<[string, string[]]>([
    ['resume', ['resume', '--yes']],
    ['close', ['close']],
    ['broadcast', ['broadcast', 'hello', '--yes']],
  ])('never signals for %s', async (_name, argv) => {
    const world = scenario();
    const { code } = await runCli(argv, [worker()], world.opts);
    expect(code).toBe(2);
    expect(world.kills).toEqual([]);
  });

  it('keeps waiting when the signal says ESRCH (the process is already gone), then pauses', async () => {
    const world = scenario({ killMode: 'already-gone' });
    const { code } = await runCli(['pause', '--yes'], [worker()], world.opts);
    expect(code).toBe(0);
    expect(world.kills).toHaveLength(1);
    expect(world.pauseRuns()).toHaveLength(1);
  });

  it('exits 2 on EPERM and writes nothing', async () => {
    const world = scenario({ killMode: 'eperm' });
    const { code, err, port } = await runCli(['pause', '--yes'], [worker()], world.opts);
    expect(code).toBe(2);
    expect(err).toContain('not allowed to stop the broadcast');
    expect(world.pauseRuns()).toEqual([]);
    expect(world.record()).toMatchObject({ status: 'open', pid: BROADCAST_PID });
    expect(port.sends).toEqual([]);
  });

  it('exits 2 when the lock is still held after the named wait, and writes nothing', async () => {
    const world = scenario({ killMode: 'ignored' });
    const clock = fakeClock();
    const { code, err, port } = await runCli(['pause', '--yes'], [worker()], { ...world.opts, clock });
    expect(code).toBe(2);
    expect(err).toContain('did not stop within 5 s');
    expect(HANDOVER_TIMEOUT_MS).toBe(5000);
    expect(clock.slept).toBe(HANDOVER_TIMEOUT_MS);
    expect(world.kills).toHaveLength(1);
    expect(world.pauseRuns()).toEqual([]);
    expect(port.sends).toEqual([]);
  });

  it('fails at once when another process takes the lock during the wait', async () => {
    const world = scenario({ killMode: 'other-holder' });
    const clock = fakeClock();
    const { code, err } = await runCli(['pause', '--yes'], [worker()], { ...world.opts, clock });
    expect(code).toBe(2);
    expect(err).toContain('another orca-broadcast is running');
    expect(clock.slept).toBe(0);
    expect(world.pauseRuns()).toEqual([]);
  });

  it('does not signal when no agent would be selected, and leaves the broadcast and its lock alone', async () => {
    const world = scenario();
    const done: FakeAgent = { paneKey: 'a:1', behavior: () => ({ state: 'done', message: 'idle' }) };
    const { code, out } = await runCli(['pause', '--yes'], [done], world.opts);
    expect(code).toBe(0);
    expect(out).toContain('nothing to pause');
    expect(world.kills).toEqual([]);
    expect(world.files()).toContain('lock');
    expect(world.record()).toMatchObject({ status: 'open', pid: BROADCAST_PID });
  });

  it('gives the usual JSON for nothing to pause, with no signal', async () => {
    const world = scenario();
    const { code, out } = await runCli(['pause', '--yes', '--json'], [], world.opts);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ command: 'pause', outcome: 'nothing-to-do', exitCode: 0, run: null, record: null, error: null, warnings: [] });
    expect(world.kills).toEqual([]);
  });

  it('sends no signal for a bad --reason', async () => {
    const world = scenario();
    const { code } = await runCli(['pause', '--reason', 'nonsense', '--yes'], [worker()], world.opts);
    expect(code).toBe(2);
    expect(world.kills).toEqual([]);
  });

  it('sends no signal for a typo in a filter value, and leaves the broadcast and its lock alone', async () => {
    const world = scenario();
    const { code, err, port } = await runCli(['pause', '--yes', '--repo', 'no-such-repo'], [worker()], world.opts);
    expect(code).toBe(2);
    expect(err).toContain('no-such-repo');
    expect(world.kills).toEqual([]);
    expect(port.sends).toEqual([]);
    expect(world.files()).toContain('lock');
    expect(world.record()).toMatchObject({ status: 'open', pid: BROADCAST_PID });
    expect(world.pauseRuns()).toEqual([]);
  });

  // The scenario with a groups.json next to the state folder, written when the scenario is seeded.
  const withGroups = (world: ReturnType<typeof scenario>, groups: Record<string, Record<string, string[]>>): RunCliOptions => ({
    ...world.opts,
    seed: async (store, stateHome) => {
      await world.opts.seed?.(store, stateHome);
      await seedGroups(groups)(store, stateHome);
    },
  });

  it.each([
    ['an unknown name', ['--group', 'nope'], {}, 'unknown group "nope"'],
    ['a state-only group', ['--group', 'idle'], { idle: { state: ['working'] } }, 'only filters by state'],
    ['a group value that no longer resolves', ['--group', 'gone'], { gone: { repo: ['vanished'] } }, 'group gone: unknown --repo "vanished"'],
    ['an unknown name among several', ['--group', 'a', '--group', 'nope'], { a: { role: ['session'] } }, 'unknown group "nope"'],
  ])('sends no signal for %s, and leaves the broadcast and its lock alone', async (_label, flags, groups, message) => {
    const world = scenario();
    const { code, err, port } = await runCli(['pause', '--yes', ...flags], [worker()], withGroups(world, groups));
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(world.kills).toEqual([]);
    expect(port.sends).toEqual([]);
    expect(world.files()).toContain('lock');
    expect(world.record()).toMatchObject({ status: 'open', pid: BROADCAST_PID });
    expect(world.pauseRuns()).toEqual([]);
  });

  it('checks the group values before the lock: a stale value is reported even while another process holds the lock', async () => {
    const world = scenario({ noRecord: true });
    const { code, err } = await runCli(['pause', '--yes', '--group', 'gone'], [worker()], withGroups(world, { gone: { repo: ['vanished'] } }));
    expect(code).toBe(2);
    expect(err).toContain('group gone: unknown --repo "vanished"');
    expect(err).not.toContain('another orca-broadcast is running');
    expect(world.kills).toEqual([]);
  });

  it('does not signal when the group selects nobody, and stops the broadcast when it selects an agent', async () => {
    const nobody = scenario();
    const none = await runCli(['pause', '--yes', '--group', 'leads'], [worker()], withGroups(nobody, { leads: { role: ['coordinator'] } }));
    expect(none.code).toBe(0);
    expect(none.out).toContain('nothing to pause');
    expect(nobody.kills).toEqual([]);
    expect(nobody.record()).toMatchObject({ status: 'open', pid: BROADCAST_PID });

    const some = scenario();
    const hit = await runCli(['pause', '--yes', '--group', 'solo'], [worker()], withGroups(some, { solo: { role: ['session'] } }));
    expect(hit.code).toBe(0);
    expect(some.kills).toEqual([[BROADCAST_PID, 'SIGTERM']]);
  });

  it('hands over for a union when any group selects an agent, and not when none does', async () => {
    const some = scenario();
    const hit = await runCli(['pause', '--yes', '--group', 'leads', '--group', 'solo'], [worker()], withGroups(some, { leads: { role: ['coordinator'] }, solo: { role: ['session'] } }));
    expect(hit.code).toBe(0);
    expect(some.kills).toEqual([[BROADCAST_PID, 'SIGTERM']]);

    const nobody = scenario();
    const none = await runCli(['pause', '--yes', '--group', 'leads', '--group', 'ops'], [worker()], withGroups(nobody, { leads: { role: ['coordinator'] }, ops: { role: ['worker'] } }));
    expect(none.out).toContain('nothing to pause');
    expect(nobody.kills).toEqual([]);
    expect(nobody.record()).toMatchObject({ status: 'open', pid: BROADCAST_PID });
  });

  it('does not signal when the filters select nobody, and leaves the broadcast alone', async () => {
    const world = scenario();
    const { code, out } = await runCli(['pause', '--yes', '--role', 'coordinator'], [worker()], world.opts);
    expect(code).toBe(0);
    expect(out).toContain('nothing to pause');
    expect(world.kills).toEqual([]);
    expect(world.record()).toMatchObject({ status: 'open', pid: BROADCAST_PID });
  });

  it('exits 130 with pause writing nothing when interrupted during the lock wait', async () => {
    const world = scenario({ killMode: 'ignored' });
    const signals = new EventEmitter();
    const clock = fakeClock();
    clock.onSleep = () => signals.emit('SIGINT');
    const { code, out } = await runCli(['pause', '--yes', '--json'], [worker()], { ...world.opts, clock, signals });
    expect(code).toBe(130);
    expect(JSON.parse(out)).toMatchObject({ command: 'pause', outcome: 'error', exitCode: 130 });
    expect(world.pauseRuns()).toEqual([]);
    expect(world.record()).toMatchObject({ status: 'open' });
  });
});

describe('the first prompt and the commit point', () => {
  it('shows the first prompt, no late prompt, and commits only after the yes', async () => {
    const world = scenario();
    const { code, questions } = await runCli(['pause'], [worker()], { ...world.opts, ask: ['y'] });
    expect(code).toBe(0);
    expect(questions).toEqual(['Send to 1 agent? [y/N] ']);
    expect(world.record().targets[0]).toMatchObject({ status: 'abandoned', reason: 'paused' });
  });

  it('writes nothing after a decline: the stopped broadcast stays open with no pid', async () => {
    const world = scenario();
    const { code, err, port } = await runCli(['pause'], [worker()], { ...world.opts, ask: ['n'] });
    expect(code).toBe(2);
    expect(err).toContain('cancelled');
    expect(world.kills).toHaveLength(1);
    expect(world.pauseRuns()).toEqual([]);
    expect(world.pointer()).toEqual({ kind: 'broadcast', id: 'b-1' });
    expect(world.record()).toMatchObject({ status: 'open' });
    expect(world.record()).not.toHaveProperty('pid');
    expect(world.record().targets[0]).toMatchObject({ status: 'pending' });
    expect(port.sends).toEqual([]);
  });

  it('writes nothing after Ctrl-C at the prompt', async () => {
    const world = scenario();
    const { code } = await runCli(['pause'], [worker()], { ...world.opts, ask: [CTRL_C] });
    expect(code).toBe(130);
    expect(world.pauseRuns()).toEqual([]);
    expect(world.record()).toMatchObject({ status: 'open' });
  });

  it('writes nothing when the re-list after the yes fails', async () => {
    const world = scenario();
    let orca: { failListingsFrom: number | null; listCalls: number } | undefined;
    const { code } = await runCli(['pause'], [worker()], {
      ...world.opts,
      configure: (port) => (orca = port),
      ask: [
        () => {
          if (orca) orca.failListingsFrom = orca.listCalls + 1;
          return 'y';
        },
      ],
    });
    expect(code).toBe(2);
    expect(world.pauseRuns()).toEqual([]);
    expect(world.pointer()).toEqual({ kind: 'broadcast', id: 'b-1' });
    expect(world.record()).toMatchObject({ status: 'open' });
  });

  it('writes nothing when the rebuild after the yes selects nobody, and the broadcast stays open', async () => {
    const world = scenario();
    const agent = worker();
    const { code, out } = await runCli(['pause'], [agent], {
      ...world.opts,
      ask: [
        () => {
          agent.behavior = () => ({ state: 'done', message: 'idle' });
          return 'y';
        },
      ],
    });
    expect(code).toBe(0);
    expect(out).toContain('nothing to pause');
    expect(world.pauseRuns()).toEqual([]);
    expect(world.record()).toMatchObject({ status: 'open' });
  });
});

describe('recovery of two open records', () => {
  const seedBoth = async (store: Parameters<NonNullable<RunCliOptions['seed']>>[0]) => {
    await store.saveBroadcast(openBroadcastRecord([broadcastTarget('a:1')]));
    await seedOpenRun(store, [agentRecord('a:1')]);
  };
  const read = async (dir: string) => JSON.parse(await readFile(join(dir, 'orca-broadcast', 'broadcasts', 'b-1.json'), 'utf8')) as BroadcastRecord;

  it.each([
    ['pause', ['pause', '--yes']],
    ['resume', ['resume', '--yes']],
    ['broadcast', ['broadcast', 'hello', '--yes']],
  ])('%s reports the broadcast it abandoned beside the open pause run', async (_name, argv) => {
    const { err, dir } = await runCli(argv, [{ paneKey: 'a:1', behavior: working }], { seed: seedBoth, newToken });
    expect(err).toContain('broadcast b-1 was open beside a pause run and is now abandoned');
    expect((await read(dir)).targets[0]).toMatchObject({ status: 'abandoned', reason: 'paused' });
  });

  it('keeps a lone open broadcast open for a command that does not touch it', async () => {
    const { dir } = await runCli(['resume', '--yes'], [], { newToken, seed: (store) => store.saveBroadcast(openBroadcastRecord([broadcastTarget('a:1')])) });
    expect(await readdir(join(dir, 'orca-broadcast', 'broadcasts'))).toEqual(['b-1.json']);
    expect(await read(dir)).toMatchObject({ status: 'open' });
  });
});

describe('the broadcast and SIGTERM', () => {
  it('saves its record with no pid and its pending target not abandoned, and exits 130', async () => {
    const signals = new EventEmitter();
    const clock = fakeClock();
    clock.onSleep = () => signals.emit('SIGTERM');
    const { code, dir } = await runCli(['broadcast', 'hello', '--yes', '--timeout', '10m'], [{ paneKey: 'a:1', behavior: working }], { newToken, clock, signals });
    expect(code).toBe(130);
    const names = await readdir(join(dir, 'orca-broadcast', 'broadcasts'));
    const record = JSON.parse(await readFile(join(dir, 'orca-broadcast', 'broadcasts', names[0] as string), 'utf8')) as BroadcastRecord;
    expect(record).toMatchObject({ status: 'open' });
    expect(record).not.toHaveProperty('pid');
    expect(record).not.toHaveProperty('startTime');
    expect(record.targets[0]).toMatchObject({ status: 'pending' });
  });
});

describe('pause stops a broadcast re-run', () => {
  const RERUN_PID = 4242;
  const RERUN_START = '77';
  const PAUSE_PID = 5000;

  // A clock whose sleeps really yield, so that the two commands, which run in this process, take turns.
  const turnTakingClock = (onFirstSleep: () => void = () => {}) => {
    let slept = 0;
    let first = true;
    return {
      now: () => 1_000_000 + slept,
      sleep: async (ms: number) => {
        slept += ms;
        if (first) {
          first = false;
          onFirstSleep();
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    };
  };

  it.each<['its prompt' | 'its wait loop']>([['its prompt'], ['its wait loop']])(
    'verifies the owner, sends SIGTERM to the re-run that waits at %s, then abandons its unacked targets as paused and closes the broadcast',
    async (where) => {
      const signals = new EventEmitter();
      const kills: [number, NodeJS.Signals][] = [];
      const pids = new Map([[RERUN_PID, RERUN_START], [PAUSE_PID, '1']]);
      let stateHome = '';
      let pausing: ReturnType<typeof runCli> | undefined;
      // The pause starts while the re-run waits. Its fake kill delivers the SIGTERM to the re-run's signal source.
      const startPause = () => {
        pausing = runCli(['pause', '--yes'], [worker()], {
          newToken,
          env: { XDG_STATE_HOME: stateHome },
          clock: turnTakingClock(),
          storeOptions: { pid: PAUSE_PID, isAlive: (pid) => pids.has(pid), readStartTime: (pid) => pids.get(pid) },
          kill: (pid, signal) => {
            kills.push([pid, signal]);
            signals.emit(signal);
          },
        });
      };
      const atPrompt = where === 'its prompt';
      const { code, dir, port } = await runCli(['broadcast', '--timeout', '1h', ...(atPrompt ? [] : ['--yes'])], [{ paneKey: 'a:1', behavior: working }], {
        newToken,
        signals,
        clock: turnTakingClock(atPrompt ? () => {} : startPause),
        storeOptions: { pid: RERUN_PID, readStartTime: (pid) => pids.get(pid) },
        // A target that still needs the message makes the re-run ask; a sent one makes it a pure wait.
        seed: async (store, home) => {
          stateHome = home;
          const record = openBroadcastRecord([broadcastTarget('a:1', atPrompt ? { messagePending: true, reason: null } : { baseline: 'Earlier reply.' })]);
          await store.saveBroadcast(record);
          await store.setCurrent('broadcast', record.id);
        },
        ask: atPrompt
          ? [
              (signal) => {
                // The record already holds this process's pid and start time: the proof the pause needs.
                startPause();
                return new Promise<string>((_, reject) => signal?.addEventListener('abort', () => reject(new Interrupted(signal)), { once: true }));
              },
            ]
          : undefined,
      });
      const paused = await pausing;

      expect(code).toBe(130); // the re-run took the SIGTERM like Ctrl-C
      expect(port.sends).toEqual([]); // and sent nothing
      expect(kills).toEqual([[RERUN_PID, 'SIGTERM']]);
      expect(paused?.code).toBe(0);
      expect(paused?.err).toContain('broadcast b-1 was closed by this pause: 1 agent had not acknowledged it and will not be waited for');
      const stateDir = join(dir, 'orca-broadcast');
      const record = JSON.parse(await readFile(join(stateDir, 'broadcasts', 'b-1.json'), 'utf8')) as BroadcastRecord;
      expect(record).toMatchObject({ status: 'closed' });
      expect(record).not.toHaveProperty('pid');
      expect(record.targets[0]).toMatchObject({ status: 'abandoned', reason: 'paused' });
      expect(await readdir(join(stateDir, 'pauses'))).toHaveLength(1);
      expect(JSON.parse(await readFile(join(stateDir, 'current'), 'utf8'))).toMatchObject({ kind: 'pause' });
    },
  );
});
