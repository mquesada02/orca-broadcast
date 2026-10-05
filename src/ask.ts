import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { Interrupted } from './abort.js';

export class PromptInterrupted extends Error {
  constructor() {
    super('interrupted at the prompt');
  }
}

// One readline per question, always closed, so nothing keeps the process alive after the answer.
// An empty answer means the input closed. Ctrl-C rejects with PromptInterrupted, because raw mode hides it from the process.
export function createAsk(input: Readable, output: Writable & { isTTY?: boolean }) {
  return (question: string, signal?: AbortSignal): Promise<string> =>
    new Promise((resolve, reject) => {
      const rl = createInterface({ input, output, terminal: output.isTTY === true });
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        rl.close();
        finish();
      };
      const onAbort = () => settle(() => reject(new Interrupted(signal!)));
      rl.on('close', () => settle(() => resolve('')));
      rl.on('SIGINT', () => settle(() => reject(new PromptInterrupted())));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      rl.question(question, (answer) => settle(() => resolve(answer)));
    });
}
