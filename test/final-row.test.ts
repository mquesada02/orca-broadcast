import { describe, expect, it } from 'vitest';
import { isFinalRow } from '../src/recover-record.js';
import type { RecoveryRow, RunRecoveryRow } from '../src/types.js';

type Probe = Pick<RunRecoveryRow, 'status' | 'reason' | 'promptDue' | 'coordinatorSessionId' | 'sessionId'>;
const probe = (status: RecoveryRow['status'], extra: Partial<Probe> = {}): Probe => ({ status, reason: null, promptDue: false, coordinatorSessionId: undefined, sessionId: 's-1', ...extra });

describe('isFinalRow', () => {
  it.each([
    ['acked', {}, true],
    ['gone', {}, true],
    ['left-to-coordinator', {}, true],
    ['failed', {}, true],
    ['abandoned', {}, true],
    ['pending', {}, false],
    ['restored', { promptDue: false }, true],
    ['restored', { promptDue: true }, false],
    ['restarted', { promptDue: false }, true],
    ['restarted', { promptDue: true }, false],
    ['no-coordinator', {}, true],
  ] as const)('%s %j gives %s, as before', (status, extra, expected) => {
    expect(isFinalRow(probe(status, extra), [])).toBe(expected);
  });

  it('keeps a worker that waits for a pending coordinator open, and closes it when the coordinator is final', () => {
    const worker = probe('no-coordinator', { reason: 'coordinator-missing', coordinatorSessionId: 's-c' });
    expect(isFinalRow(worker, [worker, probe('pending', { sessionId: 's-c' })])).toBe(false);
    expect(isFinalRow(worker, [worker, probe('acked', { sessionId: 's-c' })])).toBe(true);
  });

  it('takes rows whose session ID is null', () => {
    expect(isFinalRow(probe('acked', { sessionId: null }), [probe('acked', { sessionId: null })])).toBe(true);
    expect(isFinalRow(probe('restarted', { promptDue: true, sessionId: null }), [])).toBe(false);
    const worker = probe('no-coordinator', { reason: 'coordinator-missing', coordinatorSessionId: 's-c' });
    expect(isFinalRow(worker, [probe('pending', { sessionId: null }), worker])).toBe(true);
    expect(isFinalRow(worker, [probe('pending', { sessionId: 's-c' }), probe('pending', { sessionId: null })])).toBe(false);
  });
});
