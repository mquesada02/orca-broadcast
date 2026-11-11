import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));

const filesNaming = (needle: string | RegExp) => sources.filter(({ text }) => (typeof needle === 'string' ? text.includes(needle) : needle.test(text))).map(({ file }) => file).sort();

describe('module boundaries', () => {
  it('only the adapter imports node:child_process', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(filesNaming(/from\s+['"](node:)?child_process['"]|require\(\s*['"](node:)?child_process['"]/)).toEqual(['orca-adapter.ts']);
  });

  it('only the adapter and the store name /proc', () => {
    expect(filesNaming('/proc')).toEqual(['orca-adapter.ts', 'store.ts']);
  });

  it('only the port, its adapter, the transcript reader and the shared proof helpers name readTranscript', () => {
    expect(filesNaming('readTranscript').filter((file) => !['orca-adapter.ts', 'shared.ts', 'transcript.ts', 'types.ts'].includes(file))).toEqual([]);
  });

  it('no src file names profile-state.db or backup', () => {
    expect(filesNaming('profile-state.db')).toEqual([]);
    expect(filesNaming('backup')).toEqual([]);
  });
});
