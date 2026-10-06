import { describe, expect, it } from 'vitest';
import { continueSentence, describeReason, isPreset, pauseSentence } from '../src/reasons.js';

describe('reasons', () => {
  it('accepts exactly the four preset names', () => {
    for (const name of ['network', 'away', 'end-of-day', 'limit']) expect(isPreset(name)).toBe(true);
    for (const name of ['', 'Network', 'toString', 'constructor', 'rest']) expect(isPreset(name)).toBe(false);
  });

  it('gives the pause and continue sentence of each preset', () => {
    expect([pauseSentence('network'), continueSentence('network')]).toEqual(['The user is leaving and the network will drop.', 'The network is back.']);
    expect([pauseSentence('away'), continueSentence('away')]).toEqual(['The user is stepping away for a while.', 'The user is back.']);
    expect([pauseSentence('end-of-day'), continueSentence('end-of-day')]).toEqual(['The user is stopping work for the day.', 'The user is back for a new session.']);
    expect([pauseSentence('limit'), continueSentence('limit')]).toEqual(['The user is close to a usage or rate limit.', 'The limit has reset.']);
  });

  it('gives the neutral sentences for an absent or unknown value', () => {
    for (const value of [undefined, 'toString', 'bogus']) {
      expect(pauseSentence(value)).toBe('The user asked all agents to pause.');
      expect(continueSentence(value)).toBe('The user asked you to continue.');
    }
  });

  it('names a reason, and "no reason" for an absent one', () => {
    expect(describeReason('end-of-day')).toBe('end-of-day');
    expect(describeReason(undefined)).toBe('no reason');
  });
});
