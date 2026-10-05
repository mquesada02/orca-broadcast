import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Interrupted } from '../src/abort.js';
import { createAsk, PromptInterrupted } from '../src/ask.js';

function streams(terminal = false) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { isTTY: terminal });
  let written = '';
  output.on('data', (chunk) => (written += chunk));
  return { input, output, written: () => written };
}

describe('createAsk', () => {
  it('writes the question and returns the answer line', async () => {
    const { input, output, written } = streams();
    const pending = createAsk(input, output)('Send? ');
    input.write('yes\n');
    expect(await pending).toBe('yes');
    expect(written()).toContain('Send? ');
  });

  it('answers an empty string when the input closes', async () => {
    const { input, output } = streams();
    const pending = createAsk(input, output)('Send? ');
    input.end();
    expect(await pending).toBe('');
  });

  it('rejects with PromptInterrupted on Ctrl-C, never an empty answer', async () => {
    const { input, output } = streams(true);
    const pending = createAsk(input, output)('Send? ');
    input.write('\x03');
    await expect(pending).rejects.toBeInstanceOf(PromptInterrupted);
  });

  it('closes the readline and rejects with Interrupted when the signal aborts', async () => {
    const { input, output } = streams();
    const abort = new AbortController();
    const pending = createAsk(input, output)('Send? ', abort.signal);
    abort.abort('SIGTERM');
    await expect(pending).rejects.toBeInstanceOf(Interrupted);
    expect(input.listenerCount('keypress')).toBe(0);
    expect(input.listenerCount('data')).toBe(0);
  });
});
