import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterOptions } from '../../src/orca-adapter.js';

/**
 * The options argument of `createOrcaAdapter(exec, options)` for a test: an empty fixture `/proc` (with a boot ID) and an empty Claude Code
 * folder in a temporary folder, so the scan of a command never reads the real machine.
 */
export function scanOptions(): AdapterOptions {
  const root = mkdtempSync(join(tmpdir(), 'orca-broadcast-scan-'));
  const procRoot = join(root, 'proc');
  const claudeDir = join(root, 'claude');
  mkdirSync(join(procRoot, 'sys/kernel/random'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  copyFileSync(join(import.meta.dirname, '..', 'fixtures', 'boot-id.txt'), join(procRoot, 'sys/kernel/random/boot_id'));
  return { procRoot, claudeDir, uid: 1000 };
}
