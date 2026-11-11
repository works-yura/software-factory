import { describe, expect, it } from 'vitest';

import { codexRateLimitsToLimits, codexRateLimitsToWindows, codexUsageLimitResetAt, codexUsageLimitsUpdate, mergeCodexRateLimits } from './usageLimits.ts';

describe('Codex usage limits', () => {
  it('reads primary and secondary windows as the session and weekly allowance', () => {
    expect(
      codexRateLimitsToWindows({
        planType: 'plus',
        primary: { usedPercent: 42, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 120, windowDurationMins: 7 * 24 * 60 },
      }),
    ).toEqual([
      { id: 'primary', kind: 'session', label: 'Session', usedPercent: 42, windowDurationMins: 300, resetsAt: '2027-01-15T08:00:00.000Z' },
      { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 100, windowDurationMins: 10_080 },
    ]);
  });

  it('reads a Free plan as monthly, keeps model-specific limits out and lists reset credits', () => {
    expect(codexRateLimitsToWindows({ planType: 'free', primary: { usedPercent: 10 } })[0]).toMatchObject({ kind: 'monthly' });
    expect(codexRateLimitsToWindows({ limitId: 'gpt-x', primary: { usedPercent: 10 } })).toEqual([]);
    const limits = codexRateLimitsToLimits({
      snapshot: { primary: { usedPercent: 5 } },
      resetCredits: { availableCount: 2, credits: [{ status: 'available', expiresAt: 1_800_000_000 }, { status: 'used', expiresAt: 1 }] },
      checkedAt: '2026-11-11T00:00:00.000Z',
    });
    expect(limits.resetCredits).toEqual({ availableCount: 2, nextExpiresAt: '2027-01-15T08:00:00.000Z' });
  });

  it('merges partial updates and finds when an exhausted allowance resets', () => {
    const merged = mergeCodexRateLimits(
      { planType: 'plus', primary: { usedPercent: 100, resetsAt: 1_800_000_000 } },
      { secondary: { usedPercent: 100, resetsAt: 1_800_003_600 } },
    );
    expect(merged).toMatchObject({ planType: 'plus', primary: { usedPercent: 100 }, secondary: { usedPercent: 100 } });
    expect(codexUsageLimitResetAt(merged)).toBe('2027-01-15T09:00:00.000Z');
    expect(mergeCodexRateLimits(merged, { limitId: 'gpt-x', primary: { usedPercent: 0 } })).toBe(merged);
    expect(codexUsageLimitResetAt({ primary: { usedPercent: 99 } })).toBeNull();
  });
});

describe('codexUsageLimitsUpdate', () => {
  it('turns a rate-limit notification into the windows of the account the turn runs on', () => {
    const now = new Date('2026-11-11T18:00:00.000Z');
    expect(
      codexUsageLimitsUpdate(
        { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_793_000_000 }, secondary: { usedPercent: 7 } },
        'acc-1',
        now,
      ),
    ).toEqual({
      type: 'usage_limits_update',
      accountId: 'acc-1',
      checkedAt: '2026-11-11T18:00:00.000Z',
      windows: [
        { id: 'primary', kind: 'session', usedPercent: 42, windowDurationMins: 300, resetsAt: new Date(1_793_000_000_000).toISOString() },
        { id: 'secondary', kind: 'weekly', usedPercent: 7, windowDurationMins: 10080 },
      ],
    });
    expect(codexUsageLimitsUpdate({ limitId: 'gpt-5-pro', primary: { usedPercent: 1 } }, 'acc-1', now)).toBeUndefined();
  });
});
