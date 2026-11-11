import { appendFileSync, closeSync, mkdirSync, openSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOrcaAdapter } from '../src/orca-adapter.js';
import type { TranscriptIdentity } from '../src/types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CWD = '/work/my.project_x';
const START = 43133;
const PID = 4242;

const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const reply = (text: string, extra: Record<string, unknown> = {}, message: Record<string, unknown> = {}) =>
  line({ type: 'assistant', message: { model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text }], ...message }, ...extra });
const user = (content: unknown) => line({ type: 'user', message: { role: 'user', content } });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'orca-broadcast-transcript-'));
  const configDir = join(root, 'claude');
  const dir = join(configDir, 'projects', '-work-my-project-x');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(configDir, 'sessions'), { recursive: true });
  const file = join(dir, `${SESSION_ID}.jsonl`);
  const sessionFile = join(configDir, 'sessions', `${PID}.json`);
  const writeSession = (body: unknown = { sessionId: SESSION_ID, procStart: String(START), cwd: CWD }) => writeFileSync(sessionFile, typeof body === 'string' ? body : JSON.stringify(body));
  writeSession();
  writeFileSync(file, '');
  const identity: TranscriptIdentity = { sessionId: SESSION_ID, cwd: CWD, configDir, pid: PID, startTime: START };
  // Unused by the transcript method: the adapter never runs orca-ide for it.
  const port = createOrcaAdapter(async () => {
    throw new Error('unexpected exec');
  });
  const start = async (id = identity) => {
    const read = await port.readTranscript(id, 0, null, []);
    if (read.kind !== 'ok') throw new Error('no start read');
    return read;
  };
  return { root, configDir, file, sessionFile, identity, port, writeSession, start };
}

describe('readTranscript on real files', () => {
  it('finds the file from the session ID, the cwd slug and the config dir, and returns its size and file id with no entry at the send', async () => {
    const t = setup();
    appendFileSync(t.file, reply('first'));
    const read = await t.port.readTranscript(t.identity, 0, null, ['x']);
    expect(read).toMatchObject({ kind: 'ok', position: Buffer.byteLength(reply('first')), replies: [], userMatches: [] });
    expect((read as { fileId: string }).fileId).toMatch(/^\d+:\d+$/);
  });

  it('returns the replies and the user matches added after the send position, and the new position', async () => {
    const t = setup();
    appendFileSync(t.file, reply('before'));
    const sent = await t.start();
    appendFileSync(t.file, reply('Done.\n\nORCA-ACK abc') + user('please CONTINUE now') + reply('Back at work.'));
    const read = await t.port.readTranscript(t.identity, sent.position, sent.fileId, ['CONTINUE', 'absent']);
    expect(read).toEqual({
      kind: 'ok',
      fileId: sent.fileId,
      position: Buffer.byteLength(reply('before') + reply('Done.\n\nORCA-ACK abc') + user('please CONTINUE now') + reply('Back at work.')),
      replies: ['ORCA-ACK abc', 'Back at work.'],
      userMatches: ['CONTINUE'],
    });
  });

  it('never returns an entry from before the position', async () => {
    const t = setup();
    appendFileSync(t.file, reply('ORCA-ACK old') + user('CONTINUE old'));
    const sent = await t.start();
    const read = await t.port.readTranscript(t.identity, sent.position, sent.fileId, ['CONTINUE']);
    expect(read).toMatchObject({ kind: 'ok', replies: [], userMatches: [], position: sent.position });
  });

  it('never reads the bytes before the position: invalid bytes there do not matter, and a reply there is never parsed', async () => {
    const t = setup();
    writeFileSync(t.file, Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('{not json\n'), Buffer.from(reply('ORCA-ACK early'))]));
    const sent = await t.start();
    appendFileSync(t.file, reply('ORCA-ACK late'));
    const read = await t.port.readTranscript(t.identity, sent.position, sent.fileId, []);
    expect(read).toMatchObject({ kind: 'ok', replies: ['ORCA-ACK late'] });
  });

  it('returns the new position at the end of the last complete line, and a partial last line once it is complete', async () => {
    const t = setup();
    const sent = await t.start();
    const whole = reply('ORCA-ACK partial');
    appendFileSync(t.file, reply('one') + whole.slice(0, 20));
    const first = await t.port.readTranscript(t.identity, sent.position, sent.fileId, []);
    expect(first).toMatchObject({ kind: 'ok', replies: ['one'], position: Buffer.byteLength(reply('one')) });
    appendFileSync(t.file, whole.slice(20));
    const second = await t.port.readTranscript(t.identity, (first as { position: number }).position, sent.fileId, []);
    expect(second).toMatchObject({ kind: 'ok', replies: ['ORCA-ACK partial'], position: Buffer.byteLength(reply('one') + whole) });
  });

  it('skips a bad line, and a position inside a partial line skips its fragment', async () => {
    const t = setup();
    appendFileSync(t.file, reply('ORCA-ACK x'));
    const complete = Buffer.byteLength(reply('ORCA-ACK x'));
    appendFileSync(t.file, '{"type":"assistant","message":{"stop_re');
    const sent = await t.start();
    expect(sent.position).toBeGreaterThan(complete);
    appendFileSync(t.file, 'ason":"end_turn"}}\n' + 'not json\n' + '[1,2]\n' + 'null\n' + reply('after'));
    const read = await t.port.readTranscript(t.identity, sent.position, sent.fileId, []);
    expect(read).toMatchObject({ kind: 'ok', replies: ['after'] });
  });

  it('never counts side-chain, API-error, synthetic, tool-use, blank-text or non-array entries as replies, and takes the last non-blank line', async () => {
    const t = setup();
    const sent = await t.start();
    appendFileSync(
      t.file,
      reply('sidechain', { isSidechain: true }) +
        reply('api error', { isApiErrorMessage: true }) +
        reply('synthetic', {}, { model: '<synthetic>' }) +
        reply('tool use', {}, { stop_reason: 'tool_use' }) +
        reply('  \n\n ') +
        line({ type: 'assistant', message: { stop_reason: 'end_turn', content: 'plain string' } }) +
        line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'earlier' }, { type: 'text', text: '\n' }] } }) +
        line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'x' }] } }) +
        line({ type: 'system', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not assistant' }] } }) +
        reply('First paragraph.\n\nORCA-ACK abc  \n\n  \r\n') +
        reply('windows line\r\nORCA-ACK crlf\r\n'),
    );
    const read = await t.port.readTranscript(t.identity, sent.position, sent.fileId, []);
    expect(read).toMatchObject({ kind: 'ok', replies: ['ORCA-ACK abc  ', 'ORCA-ACK crlf'] });
  });

  it('matches user entries by substring in a string or in text blocks, and reports each given text once per entry', async () => {
    const t = setup();
    const sent = await t.start();
    appendFileSync(
      t.file,
      user('[wrapper] CONTINUE one [end]') +
        user([{ type: 'text', text: 'CONTINUE two' }, { type: 'tool_result', content: 'CONTINUE hidden' }, { type: 'text', text: 'second block' }]) +
        user('nothing here') +
        user('CONTINUE two and CONTINUE one'),
    );
    const read = await t.port.readTranscript(t.identity, sent.position, sent.fileId, ['CONTINUE one', 'CONTINUE two']);
    expect(read).toMatchObject({ kind: 'ok', userMatches: ['CONTINUE one', 'CONTINUE two', 'CONTINUE one', 'CONTINUE two'] });
  });

  it('is missing when the file is gone, shrunk or replaced', async () => {
    const t = setup();
    appendFileSync(t.file, reply('a') + reply('b'));
    const sent = await t.start();
    truncateSync(t.file, 3);
    expect(await t.port.readTranscript(t.identity, sent.position, sent.fileId, [])).toEqual({ kind: 'missing' });
    rmSync(t.file);
    expect(await t.port.readTranscript(t.identity, sent.position, sent.fileId, [])).toEqual({ kind: 'missing' });
  });

  it('is missing for a replaced file even when it is larger (another file id)', async () => {
    const t = setup();
    const sent = await t.start();
    // The old file is still open here, so the new one cannot reuse its inode.
    const keep = openSync(t.file, 'r');
    writeFileSync(join(t.root, 'other'), reply('x') + reply('y'));
    renameSync(join(t.root, 'other'), t.file);
    expect(await t.port.readTranscript(t.identity, sent.position, sent.fileId, [])).toEqual({ kind: 'missing' });
    closeSync(keep);
  });

  it('is missing when the session file is absent, invalid, not an object, has another start time or names another session ID', async () => {
    const t = setup();
    const sent = await t.start();
    appendFileSync(t.file, reply('x'));
    const read = () => t.port.readTranscript(t.identity, sent.position, sent.fileId, []);
    expect(await read()).toMatchObject({ kind: 'ok' });
    for (const body of ['{not json', '[1]', 'null', { sessionId: SESSION_ID, procStart: '1' }, { sessionId: SESSION_ID }, { sessionId: 'other', procStart: String(START) }]) {
      t.writeSession(body);
      expect(await read()).toEqual({ kind: 'missing' });
    }
    rmSync(t.sessionFile);
    expect(await read()).toEqual({ kind: 'missing' });
    expect(await t.port.readTranscript(t.identity, 0, null, [])).toEqual({ kind: 'missing' });
  });

  it('is missing at the send when the transcript file does not exist', async () => {
    const t = setup();
    rmSync(t.file);
    expect(await t.port.readTranscript(t.identity, 0, null, [])).toEqual({ kind: 'missing' });
  });

  it('reads the config dir of the identity, not the claudeDir option of the adapter', async () => {
    const t = setup();
    const elsewhere = createOrcaAdapter(
      async () => {
        throw new Error('unexpected exec');
      },
      { claudeDir: join(t.root, 'not-used') },
    );
    expect(await elsewhere.readTranscript(t.identity, 0, null, [])).toMatchObject({ kind: 'ok' });
  });
});
