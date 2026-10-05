#!/usr/bin/env node
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2), process.env, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: process.stderr.isTTY === true,
});
