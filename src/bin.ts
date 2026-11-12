#!/usr/bin/env node
import { createAsk } from './ask.js';
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: process.stderr.isTTY === true,
  size: () => ({ rows: process.stderr.rows ?? 0, columns: process.stderr.columns ?? 0 }),
  ask: process.stdin.isTTY && process.stderr.isTTY ? createAsk(process.stdin, process.stderr) : undefined,
});
