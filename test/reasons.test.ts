import { describe, expect, it } from 'vitest';
import { continueSentence, isPreset, mismatchMessage, pauseSentence } from '../src/reasons.js';

describe('reasons', () => {
  it('accepts exactly the five preset names', () => {
    for (const name of ['network', 'away', 'end-of-day', 'limit', 'restart']) expect(isPreset(name)).toBe(true);
    for (const name of ['', 'Network', 'toString', 'constructor', 'rest']) expect(isPreset(name)).toBe(false);
  });

  it('gives the pause and continue sentence of each preset', () => {
    expect([pauseSentence('network'), continueSentence('network')]).toEqual(['The user is leaving and the network will drop.', 'The network is back.']);
    expect([pauseSentence('away'), continueSentence('away')]).toEqual(['The user is stepping away for a while.', 'The user is back.']);
    expect([pauseSentence('end-of-day'), continueSentence('end-of-day')]).toEqual(['The user is stopping work for the day.', 'The user is back for a new session.']);
    expect([pauseSentence('limit'), continueSentence('limit')]).toEqual(['The user is close to a usage or rate limit.', 'The limit has reset.']);
    expect([pauseSentence('restart'), continueSentence('restart')]).toEqual([
      'The user will restart the PC soon, and everything in /tmp will be erased; first copy anything you still need from /tmp to a place outside it.',
      'The PC has restarted; anything you left in /tmp is gone.',
    ]);
  });

  it('gives the neutral sentences for an absent or unknown value', () => {
    for (const value of [undefined, 'toString', 'bogus']) {
      expect(pauseSentence(value)).toBe('The user asked all agents to pause.');
      expect(continueSentence(value)).toBe('The user asked you to continue.');
    }
  });

  it('words the refusal for a preset and for an absent or unknown reason', () => {
    expect(mismatchMessage('end-of-day')).toBe('This run was paused with --reason end-of-day; use --reason end-of-day, or close it first.');
    expect(mismatchMessage('restart')).toBe('This run was paused with --reason restart; use --reason restart, or close it first.');
    for (const value of [undefined, 'bogus']) {
      expect(mismatchMessage(value)).toBe('This run was paused without --reason; run pause without --reason, or close it first.');
    }
  });
});
