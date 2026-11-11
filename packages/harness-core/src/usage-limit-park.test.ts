import { describe, expect, it } from 'vitest';

import { isUsageLimitFailure, nextUsageLimitPark, USAGE_LIMIT_PARK_MAX_MS, type UsageLimitPark } from './usage-limit-park.ts';

const now = new Date('2026-11-11T12:00:00.000Z');

describe('nextUsageLimitPark', () => {
  it('parks until the provider’s reset', () => {
    const resetsAt = new Date('2026-11-11T14:30:00.000Z');
    expect(nextUsageLimitPark({ kind: 'rate_limit', message: 'out', resetsAt }, { now })).toEqual({
      reason: 'usage_limit',
      until: resetsAt.toISOString(),
      resetKnown: true,
      since: now.toISOString(),
      attempts: 1,
      message: 'out',
    });
  });

  it('waits a doubling cooldown when nobody said when the limit resets, at most an hour', () => {
    const first = nextUsageLimitPark({ kind: 'rate_limit', message: 'out' }, { now }) as UsageLimitPark;
    expect(first).toMatchObject({ until: '2026-11-11T12:05:00.000Z', resetKnown: false, attempts: 1 });
    const second = nextUsageLimitPark({ kind: 'rate_limit', message: 'out' }, { now, previous: first });
    expect(second).toMatchObject({ until: '2026-11-11T12:10:00.000Z', attempts: 2, since: now.toISOString() });
    const tenth = nextUsageLimitPark({ kind: 'rate_limit', message: 'out' }, { now, previous: { ...first, attempts: 9 } });
    expect(tenth).toMatchObject({ until: '2026-11-11T13:00:00.000Z' });
  });

  it('gives up once the first park is older than the cap', () => {
    const since = new Date(now.getTime() - USAGE_LIMIT_PARK_MAX_MS).toISOString();
    const previous = { reason: 'usage_limit' as const, until: since, resetKnown: true, since, attempts: 3, message: 'out' };
    expect(nextUsageLimitPark({ kind: 'rate_limit', message: 'out' }, { now, previous })).toBe('expired');
  });

  it('tells a usage-limit failure from others', () => {
    expect(isUsageLimitFailure({ kind: 'rate_limit', message: 'x' })).toBe(true);
    expect(isUsageLimitFailure({ kind: 'auth', message: 'x' })).toBe(false);
    expect(isUsageLimitFailure(new Error('rate limited'))).toBe(false);
  });
});
