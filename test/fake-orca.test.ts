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
    await orca.startAgent('/w', 'id', null, 't3', true);
    expect(orca.starts.map((s) => s.disableTitleUpdates)).toEqual([false, false, true]);
  });
});

describe('FakeOrca transcripts', () => {
  const identity = (sessionId: string) => ({ sessionId, cwd: '/w', configDir: '/c', pid: 1, startTime: 2 });

  it('reads "missing" for a session that a test never named', async () => {
    const orca = new FakeOrca([]);
    expect(await orca.readTranscript(identity('s1'), 0, null, [])).toEqual({ kind: 'missing' });
  });

  it('gives the size and file id at the send, then the entries added since', async () => {
    const orca = new FakeOrca([]);
    orca.transcript('s1').reply('old');
    const sent = await orca.readTranscript(identity('s1'), 0, null, []);
    expect(sent).toEqual({ kind: 'ok', fileId: 'gen-1', position: 1, replies: [], userMatches: [] });
    orca.transcript('s1').reply('ORCA-ACK a').ignored('ORCA-ACK mid-turn').user('[x] CONTINUE [y]');
    expect(await orca.readTranscript(identity('s1'), 1, 'gen-1', ['CONTINUE', 'zzz'])).toEqual({ kind: 'ok', fileId: 'gen-1', position: 4, replies: ['ORCA-ACK a'], userMatches: ['CONTINUE'] });
    expect(orca.transcriptReads.map((r) => r.position)).toEqual([0, 1]);
  });

  it('keeps a partial entry unreadable until it is completed', async () => {
    const orca = new FakeOrca([]);
    orca.transcript('s1').partial('reply', 'ORCA-ACK p');
    expect(await orca.readTranscript(identity('s1'), 0, 'gen-1', [])).toMatchObject({ replies: [], position: 0 });
    orca.transcript('s1').complete();
    expect(await orca.readTranscript(identity('s1'), 0, 'gen-1', [])).toMatchObject({ replies: ['ORCA-ACK p'], position: 1 });
  });

  it('reads "missing" after remove, shrink below the position or replace', async () => {
    const orca = new FakeOrca([]);
    orca.transcript('s1').reply('a').reply('b');
    expect(await orca.readTranscript(identity('s1'), 2, 'gen-1', [])).toMatchObject({ kind: 'ok' });
    orca.transcript('s1').shrink(1);
    expect(await orca.readTranscript(identity('s1'), 2, 'gen-1', [])).toEqual({ kind: 'missing' });
    orca.transcript('s1').replace();
    expect(await orca.readTranscript(identity('s1'), 0, 'gen-1', [])).toEqual({ kind: 'missing' });
    expect(await orca.readTranscript(identity('s1'), 0, null, [])).toMatchObject({ fileId: 'gen-2' });
    orca.transcript('s1').remove();
    expect(await orca.readTranscript(identity('s1'), 0, null, [])).toEqual({ kind: 'missing' });
  });
});
