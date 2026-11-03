import { describe, expect, it } from 'vitest';
import { FakeOrca, working } from './helpers/fake-orca.js';

describe('FakeOrca new port methods', () => {
  it('never pairs the runtime ID of one listing with the rows of another', async () => {
    const orca = new FakeOrca([{ paneKey: 'a:1', behavior: working, rowAt: (listing) => listing === 1 }, { paneKey: 'b:2', behavior: working, rowAt: (listing) => listing === 2 }]);
    orca.runtimeIdAt = (listing) => (listing === 1 ? 'runtime-old' : 'runtime-new');
    const first = await orca.listAgentsWithRuntime();
    const second = await orca.listAgentsWithRuntime();
    expect(first.rows.map((r) => r.paneKey)).toEqual(['a:1']);
    expect(first.runtimeId).toBe('runtime-old');
    expect(second.rows.map((r) => r.paneKey)).toEqual(['b:2']);
    expect(second.runtimeId).toBe('runtime-new');
  });

  it('counts a runtime listing as one listing and keeps the injected failures', async () => {
    const orca = new FakeOrca([{ paneKey: 'a:1', behavior: working }]);
    orca.failListingAt = 2;
    await orca.listAgentsWithRuntime();
    await expect(orca.listAgentsWithRuntime()).rejects.toThrow('boom');
    expect(orca.listCalls).toBe(2);
  });

  it('scripts the scan, the boot ID and every start result', async () => {
    const orca = new FakeOrca([]);
    expect(await orca.scanSessions()).toEqual({ sessions: [], unknown: [], heldByOthers: [] });
    orca.failScansFrom = 2;
    await expect(orca.scanSessions()).rejects.toThrow();
    expect(await orca.bootId()).toBe('boot-1');
    orca.failBootId = true;
    await expect(orca.bootId()).rejects.toThrow();
    orca.startResultAt = (n) => (n === 1 ? { started: false, reason: 'no-transcript' } : { started: true, handle: 'term_x' });
    expect(await orca.startAgent('/w', 'id', null, 't')).toEqual({ started: false, reason: 'no-transcript' });
    expect(await orca.startAgent('/w', 'id', '--dangerously-skip-permissions', 't2')).toEqual({ started: true, handle: 'term_x' });
    expect(orca.starts.map((s) => s.title)).toEqual(['t', 't2']);
  });
});
