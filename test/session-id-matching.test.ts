import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentRecord, FakeOrca, PAUSED_REPLY, repliesWithToken, seedOpenRun, startsNewTurnAfterContinue, working, type Behavior, type FakeAgent } from './helpers/fake-orca.js';
import { scanOf } from './helpers/roster.js';
import { runCli, type RunCliOptions } from './helpers/run-cli.js';
import type { AgentRecord, Run, SessionRecord } from '../src/types.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'abcd1234';
const COORDINATOR_SENTENCE = 'Do not dispatch new workers or tasks.';

type Held = (Pick<SessionRecord, 'sessionId' | 'paneKey'> & Partial<SessionRecord>)[];
/** A port whose scan shows these sessions in these panes. */
const scanning =
  (...held: Held) =>
  (port: FakeOrca): void => {
    port.scanAt = () => scanOf(...held);
  };
const seed = (...records: AgentRecord[]): RunCliOptions['seed'] => (store) => seedOpenRun(store, records);
/** A seed that also keeps the text of the run file it wrote, to compare with the file after a command that must not change it. */
const seedCapturing = (...records: AgentRecord[]): { seed: NonNullable<RunCliOptions['seed']>; text: () => string } => {
  let written = '';
  return {
    seed: async (store, dir) => {
      await seedOpenRun(store, records);
      written = await readFile(runPath(dir), 'utf8');
    },
    text: () => written,
  };
};
const runPath = (dir: string): string => join(dir, 'orca-broadcast', 'pauses', 'run-1.json');
const runText = (dir: string): Promise<string> => readFile(runPath(dir), 'utf8');
const readRun = async (dir: string): Promise<Run> => JSON.parse(await runText(dir)) as Run;
const handle = (paneKey: string): string => `term_${paneKey}`;
const continues = (port: FakeOrca): string[] => port.sends.filter((s) => s.text.startsWith('[orca-broadcast] CONTINUE')).map((s) => s.handle);
const idle = (paneKey: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({ paneKey, behavior: startsNewTurnAfterContinue, ...extra });
/** A recorded agent of a pause run that holds this session. */
const recorded = (paneKey: string, sessionId: string, extra: Partial<AgentRecord> = {}): AgentRecord => agentRecord(paneKey, { sessionId, pauseBaseline: PAUSED_REPLY, ...extra });
const tty: RunCliOptions = { isTTY: true };

describe('resume finds the agents of a run by session ID', () => {
  it('continues a restored agent in a new pane, names it in the confirmation list and writes the new pane to the run', async () => {
    const { code, port, dir, err } = await runCli(['resume'], [idle('new:1')], { ...tty, ask: ['y'], newToken: () => TOKEN, seed: seed(recorded('old:1', S1)), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect(code).toBe(0);
    expect(err).toContain('repo/tree-old:1 (worker)');
    expect(continues(port)).toEqual([handle('new:1')]);
    const run = await readRun(dir);
    expect(run.agents[0]).toMatchObject({ paneKey: 'new:1', lastHandle: handle('new:1'), resumeStatus: 'resumed', sessionId: S1 });
  });

  it('uses the scan of the start save: one scan with --yes, and none of its own', async () => {
    const { port } = await runCli(['resume', '--yes'], [idle('new:1')], { seed: seed(recorded('old:1', S1)), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect(port.scanCalls).toBe(1);
  });

  it('keeps the paneKey behaviour for a run with no session IDs: a moved agent is gone, an unmoved one is continued', async () => {
    const { code, port, dir } = await runCli(['resume', '--yes'], [idle('same:1'), idle('new:1')], { seed: seed(agentRecord('old:1'), agentRecord('same:1')), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect(code).toBe(0);
    expect(continues(port)).toEqual([handle('same:1')]);
    const run = await readRun(dir);
    expect(run.agents.map((a) => [a.paneKey, a.resumeStatus])).toEqual([['old:1', 'gone'], ['same:1', 'resumed']]);
  });

  it('leaves the run file byte-for-byte as it was after a "no"', async () => {
    const seeded = seedCapturing(recorded('old:1', S1));
    const { code, port, dir } = await runCli(['resume'], [idle('new:1')], { ...tty, ask: ['n'], seed: seeded.seed, configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect(code).toBe(2);
    expect(port.sends).toEqual([]);
    expect(await runText(dir)).toBe(seeded.text());
  });

  it('leaves the run file as it was when the listing after the yes fails', async () => {
    const seeded = seedCapturing(recorded('old:1', S1));
    const { code, dir } = await runCli(['resume'], [idle('new:1')], {
      ...tty,
      ask: ['y'],
      seed: seeded.seed,
      configure: (port) => {
        scanning({ sessionId: S1, paneKey: 'new:1' })(port);
        port.failListingsFrom = 2;
      },
    });
    expect(code).toBe(2);
    expect(await runText(dir)).toBe(seeded.text());
  });

  it('recognises the self row by the new pane key and sends it nothing', async () => {
    const { code, port, dir } = await runCli(['resume', '--yes'], [idle('new:1')], { env: { ORCA_PANE_KEY: 'new:1' }, seed: seed(recorded('old:1', S1, { pauseReason: 'self' })), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect(code).toBe(0);
    expect(port.sends).toEqual([]);
    expect((await readRun(dir)).agents[0]).toMatchObject({ paneKey: 'new:1', resumeStatus: 'resumed', resumeReason: 'self' });
  });

  it('falls back to paneKey with a warning in --json when the scan fails, and still continues an unmoved agent', async () => {
    const { code, port, out } = await runCli(['resume', '--yes', '--json'], [idle('same:1')], {
      seed: seed(recorded('same:1', S1)),
      configure: (p) => {
        p.failScansFrom = 1;
      },
    });
    expect(code).toBe(0);
    expect(continues(port)).toEqual([handle('same:1')]);
    const warnings = (JSON.parse(out) as { warnings: string[] }).warnings;
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('roster not saved'), expect.stringContaining('session IDs were not matched')]));
  });

  it('adds no matching warning when the scan fails and no record has a session ID', async () => {
    const { out } = await runCli(['resume', '--yes', '--json'], [idle('same:1')], {
      seed: seed(agentRecord('same:1')),
      configure: (p) => {
        p.failScansFrom = 1;
      },
    });
    expect((JSON.parse(out) as { warnings: string[] }).warnings.filter((w) => w.includes('session IDs'))).toEqual([]);
  });

  it('finds by paneKey a record whose session ID no live agent holds while its old pane is live', async () => {
    const { port } = await runCli(['resume', '--yes'], [idle('same:1')], { seed: seed(recorded('same:1', S1)), configure: scanning({ sessionId: S2, paneKey: 'same:1' }) });
    expect(continues(port)).toEqual([handle('same:1')]);
  });

  describe('two records never end on one pane', () => {
    it('a target pane that another record holds: the record stays and falls back to paneKey', async () => {
      const { port, dir } = await runCli(['resume', '--yes'], [idle('new:1')], { seed: seed(recorded('old:1', S1), recorded('new:1', S2)), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
      expect(continues(port)).toEqual([handle('new:1')]);
      expect((await readRun(dir)).agents.map((a) => [a.paneKey, a.resumeStatus])).toEqual([['old:1', 'gone'], ['new:1', 'resumed']]);
    });

    it('two records that hold one session ID: the earlier one moves, the later one stays', async () => {
      const { dir } = await runCli(['resume', '--yes'], [idle('new:1')], { seed: seed(recorded('old:1', S1), recorded('old:2', S1)), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
      expect((await readRun(dir)).agents.map((a) => [a.paneKey, a.resumeStatus])).toEqual([['new:1', 'resumed'], ['old:2', 'gone']]);
    });

    it('two records that would swap panes both stay on their own pane', async () => {
      const { port, dir } = await runCli(['resume', '--yes'], [idle('p:1'), idle('p:2')], { seed: seed(recorded('p:1', S1), recorded('p:2', S2)), configure: scanning({ sessionId: S2, paneKey: 'p:1' }, { sessionId: S1, paneKey: 'p:2' }) });
      expect(continues(port).sort()).toEqual([handle('p:1'), handle('p:2')]);
      expect((await readRun(dir)).agents.map((a) => a.paneKey)).toEqual(['p:1', 'p:2']);
    });

    it('a gone record is never moved', async () => {
      const { dir } = await runCli(['resume', '--yes'], [idle('new:1')], { seed: seed(recorded('old:1', S1, { resumeStatus: 'gone', resumeReason: 'terminal-closed' })), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
      expect((await readRun(dir)).agents[0]).toMatchObject({ paneKey: 'old:1', resumeStatus: 'gone' });
    });
  });

  it('keeps the recorded role of a restored coordinator and worker: workers first, coordinators last, and --run still selects the worker', async () => {
    const records = [recorded('old:1', S1, { role: 'coordinator' }), recorded('old:2', S2, { role: 'worker', orchestrationRunIds: ['run_x'] })];
    const options: RunCliOptions = { seed: seed(...records), configure: scanning({ sessionId: S1, paneKey: 'new:1' }, { sessionId: S2, paneKey: 'new:2' }) };
    const all = await runCli(['resume'], [idle('new:1'), idle('new:2')], { ...options, ...tty, ask: ['y'] });
    expect(all.err).toMatch(/\(coordinator\)/);
    expect(continues(all.port)).toEqual([handle('new:2'), handle('new:1')]);

    const filtered = await runCli(['resume', '--yes', '--run', 'run_x'], [idle('new:1'), idle('new:2')], options);
    expect(continues(filtered.port)).toEqual([handle('new:2')]);
    expect((await readRun(filtered.dir)).agents[1]).toMatchObject({ role: 'worker', orchestrationRunIds: ['run_x'] });
  });
});

describe('pause finds the agents of an open run by session ID', () => {
  const resumedRecord = (paneKey: string, sessionId: string, extra: Partial<AgentRecord> = {}): AgentRecord => recorded(paneKey, sessionId, { resumeStatus: 'resumed', resumeReason: 'queued-while-working', ...extra });
  const replies: FakeAgent = { paneKey: 'new:1', behavior: repliesWithToken() };

  it('adds no second record for a restored session, refreshes its pane and handle, and pauses it in the new pane', async () => {
    const { code, port, dir } = await runCli(['pause'], [replies], { ...tty, ask: ['y'], seed: seed(resumedRecord('old:1', S1)), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect(code).toBe(0);
    expect(port.sends.map((s) => s.handle)).toEqual([handle('new:1')]);
    const run = await readRun(dir);
    expect(run.agents).toHaveLength(1);
    expect(run.agents[0]).toMatchObject({ paneKey: 'new:1', pauseStatus: 'confirmed', sessionId: S1 });
    expect(port.scanCalls).toBe(2);
  });

  it('leaves the run file byte-for-byte as it was after a "no" at the first confirmation', async () => {
    const seeded = seedCapturing(resumedRecord('old:1', S1));
    const { code, port, dir } = await runCli(['pause'], [replies], { ...tty, ask: ['n'], seed: seeded.seed, configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect(code).toBe(2);
    expect(port.sends).toEqual([]);
    expect(await runText(dir)).toBe(seeded.text());
  });

  it('leaves the run file byte-for-byte as it was after a "no" at a late confirmation', async () => {
    // Paused at first, woken by a later listing: the plan is empty at the start, so the question comes late, after the run was saved.
    const wakesLate: Behavior = ({ listCalls }) => (listCalls >= 2 ? { state: 'working', message: 'Back at work.' } : { state: 'done', message: PAUSED_REPLY });
    // A second recorded agent that is still unconfirmed keeps the wait loop running until the first one wakes.
    const unsettled = recorded('y:1', S2, { pauseStatus: 'unconfirmed', pauseReason: 'still-working', confirmedAt: null });
    const seeded = seedCapturing(recorded('old:1', S1), unsettled);
    const { code, port, dir, questions } = await runCli(['pause'], [{ paneKey: 'new:1', behavior: wakesLate }, { paneKey: 'y:1', behavior: working }], {
      ...tty,
      ask: ['n'],
      seed: seeded.seed,
      configure: scanning({ sessionId: S1, paneKey: 'new:1' }, { sessionId: S2, paneKey: 'y:1' }),
    });
    expect(questions).toHaveLength(1);
    expect(code).toBe(2);
    expect(port.sends).toEqual([]);
    expect(await runText(dir)).toBe(seeded.text());
  });

  it('records the session ID and permission flag of new agents from the scan, and none for a pane the scan missed', async () => {
    const { dir } = await runCli(['pause', '--yes'], [{ paneKey: 'a:1', behavior: repliesWithToken() }, { paneKey: 'b:2', behavior: repliesWithToken() }], {
      newToken: () => TOKEN,
      configure: scanning({ sessionId: S1, paneKey: 'a:1', permission: '--dangerously-skip-permissions' }),
    });
    const [a, b] = (await readNewRun(dir)).agents;
    expect(a).toMatchObject({ paneKey: 'a:1', sessionId: S1, permission: '--dangerously-skip-permissions' });
    expect(b).toMatchObject({ paneKey: 'b:2' });
    expect(b).not.toHaveProperty('sessionId');
    expect(b).not.toHaveProperty('permission');
  });

  it('falls back to paneKey with a warning in --json when the scan fails', async () => {
    const { out, port } = await runCli(['pause', '--yes', '--json'], [{ paneKey: 'same:1', behavior: repliesWithToken() }], {
      seed: seed(resumedRecord('same:1', S1)),
      configure: (p) => {
        p.failScansFrom = 1;
      },
    });
    expect((JSON.parse(out) as { warnings: string[] }).warnings).toEqual(expect.arrayContaining([expect.stringContaining('session IDs were not matched')]));
    expect(port.sends).toHaveLength(1);
  });

  it('keeps the recorded role and run ids of a restored coordinator that is live as a session: in the wait loop and in the pause message', async () => {
    const { port, dir } = await runCli(['pause', '--yes'], [replies], { seed: seed(resumedRecord('old:1', S1, { role: 'coordinator', orchestrationRunIds: ['run_x'] })), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect(port.sends[0]?.text).toContain(COORDINATOR_SENTENCE);
    expect((await readRun(dir)).agents[0]).toMatchObject({ paneKey: 'new:1', role: 'coordinator', orchestrationRunIds: ['run_x'] });
  });

  it('keeps the recorded role of a restored worker in markSelf, when the pause runs in its session', async () => {
    const { dir } = await runCli(['pause', '--yes'], [{ paneKey: 'new:1', behavior: working }], { env: { ORCA_PANE_KEY: 'new:1' }, seed: seed(resumedRecord('old:1', S1, { role: 'worker', orchestrationRunIds: ['run_x'] })), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect((await readRun(dir)).agents).toHaveLength(1);
    expect((await readRun(dir)).agents[0]).toMatchObject({ paneKey: 'new:1', pauseReason: 'self', role: 'worker', orchestrationRunIds: ['run_x'] });
  });

  it('lets a live role other than session replace the recorded one', async () => {
    const { dir } = await runCli(['pause', '--yes'], [replies], {
      seed: seed(resumedRecord('old:1', S1, { role: 'worker' })),
      configure: (port) => {
        scanning({ sessionId: S1, paneKey: 'new:1' })(port);
        port.coordinatorsAt = () => ['new:1'];
      },
    });
    expect((await readRun(dir)).agents[0]).toMatchObject({ paneKey: 'new:1', role: 'coordinator' });
  });

  it('makes no scan call in its polling loop: two scans, at the start and at the end', async () => {
    const wakesOnce: Behavior = ({ received, listCalls }) => (received.length === 0 || listCalls < 6 ? { state: 'working', message: null } : { state: 'done', message: `Stopped.\nORCA-PAUSED ${TOKEN}` });
    const { port } = await runCli(['pause', '--yes'], [{ paneKey: 'new:1', behavior: wakesOnce }], { newToken: () => TOKEN, seed: seed(resumedRecord('old:1', S1)), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    expect(port.scanCalls).toBe(2);
  });

  it('two records that hold one session ID never both end on the new pane', async () => {
    const { dir } = await runCli(['pause', '--yes'], [replies], { seed: seed(resumedRecord('old:1', S1), resumedRecord('old:2', S1)), configure: scanning({ sessionId: S1, paneKey: 'new:1' }) });
    const run = await readRun(dir);
    expect(run.agents.filter((a) => a.paneKey === 'new:1')).toHaveLength(1);
  });
});

/** The only run file of a state folder whose run a command created (its id is not fixed). */
async function readNewRun(dir: string): Promise<Run> {
  const names = (await readdir(join(dir, 'orca-broadcast', 'pauses'))).filter((n) => n.endsWith('.json'));
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(dir, 'orca-broadcast', 'pauses', names[0] as string), 'utf8')) as Run;
}
