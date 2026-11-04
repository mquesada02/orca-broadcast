import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string): Promise<string> => readFile(join(import.meta.dirname, '..', name), 'utf8');

describe('roster documents', () => {
  it('README holds the commands that turn the roster timer on and off, and its 5-minute interval', async () => {
    const readme = await read('README.md');
    expect(readme).toContain('systemctl --user enable --now');
    expect(readme).toContain('systemctl --user disable --now');
    expect(readme).toContain('OnUnitActiveSec=5min');
  });

  it('CONTEXT.md defines the roster term', async () => {
    expect(await read('CONTEXT.md')).toMatch(/^\*\*Roster\*\*:/m);
  });
});
