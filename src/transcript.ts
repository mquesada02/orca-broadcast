import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscriptIdentity, TranscriptRead } from './types.js';

const MISSING: TranscriptRead = { kind: 'missing' };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

// The session file of the recorded pid must still name the same session and the same process start; else the session ended, was cleared or forked, or the pid was reused.
async function sessionIsSame(identity: TranscriptIdentity): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(identity.configDir, 'sessions', `${identity.pid}.json`), 'utf8'));
    return isObject(parsed) && String(parsed.procStart) === String(identity.startTime) && parsed.sessionId === identity.sessionId;
  } catch {
    return false;
  }
}

// A blank line is empty or holds only whitespace; a `\r` before the `\n` belongs to the line break.
function lastNonBlankLine(text: string): string | null {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] as string).trim() !== '') return lines[i] as string;
  }
  return null;
}

function contentBlocks(message: Json): unknown[] | null {
  return Array.isArray(message.content) ? message.content : null;
}

// A reply ends a turn: an assistant entry, `end_turn`, not a side chain, an API error or a synthetic entry. Its item comes from the last text block only.
function replyLine(entry: Json): string | null {
  if (entry.type !== 'assistant' || entry.isSidechain === true || entry.isApiErrorMessage === true) return null;
  const message = entry.message;
  if (!isObject(message) || message.stop_reason !== 'end_turn' || message.model === '<synthetic>') return null;
  const blocks = contentBlocks(message);
  const last = blocks?.filter((block) => isObject(block) && block.type === 'text').at(-1);
  return isObject(last) && typeof last.text === 'string' ? lastNonBlankLine(last.text) : null;
}

function userText(entry: Json): string | null {
  if (entry.type !== 'user' || !isObject(entry.message)) return null;
  const { content } = entry.message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.flatMap((block) => (isObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n');
}

// Reads only the bytes after `position`, and only the complete lines among them. Every file problem is "missing"; this never throws.
export async function readTranscript(identity: TranscriptIdentity, position: number, fileId: string | null, texts: string[]): Promise<TranscriptRead> {
  if (!(await sessionIsSame(identity))) return MISSING;
  const path = join(identity.configDir, 'projects', identity.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${identity.sessionId}.jsonl`);
  let handle;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    const id = `${stat.dev}:${stat.ino}`;
    if (fileId === null) return { kind: 'ok', fileId: id, position: stat.size, replies: [], userMatches: [] };
    if (id !== fileId || stat.size < position) return MISSING;

    const buffer = Buffer.alloc(stat.size - position);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, position + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const read = buffer.subarray(0, filled);
    const complete = read.subarray(0, read.lastIndexOf(0x0a) + 1);

    const replies: string[] = [];
    const userMatches: string[] = [];
    for (const line of complete.toString('utf8').split('\n')) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(entry)) continue;
      const reply = replyLine(entry);
      if (reply !== null) replies.push(reply);
      const text = userText(entry);
      if (text !== null) userMatches.push(...texts.filter((wanted) => text.includes(wanted)));
    }
    return { kind: 'ok', fileId: id, position: position + complete.length, replies, userMatches };
  } catch {
    return MISSING;
  } finally {
    await handle?.close().catch(() => {});
  }
}
