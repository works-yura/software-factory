import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import type { AgentEvent } from '@factory/harness';

import { fakeClaude, fixture } from './__fixtures__/fake-claude.ts';
import { createClaudeCodeHarness } from './harness.ts';
import { createInMemorySessionStore } from './store.ts';
import { claudeOAuthUsageToLimits, claudeRateLimitWindows } from './usageLimits.ts';

/** A real directory: a turn checks its recorded cwd is still on disk. */
const WORKDIR = await mkdtemp(join(tmpdir(), 'claude-cwd-'));

const RESET = 1_793_000_000;
const checkedAt = '2026-11-11T18:00:00.000Z';

describe('claudeRateLimitWindows', () => {
  it('reads a streamed window: utilization 0–1, reset in epoch seconds', () => {
    expect(claudeRateLimitWindows({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.82, resetsAt: RESET })).toEqual([
      { id: 'five_hour', kind: 'session', usedPercent: 82, windowDurationMins: 300, resetsAt: new Date(RESET * 1000).toISOString() },
    ]);
    expect(claudeRateLimitWindows({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.1 })).toEqual([
      { id: 'seven_day_opus', kind: 'model', label: 'Opus', usedPercent: 10, windowDurationMins: 10080 },
    ]);
  });

  it('reads a rejection without utilization as a used-up window, and says nothing for bare allowances', () => {
    expect(claudeRateLimitWindows({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: RESET })[0]).toMatchObject({
      id: 'seven_day',
      usedPercent: 100,
    });
    expect(claudeRateLimitWindows({ status: 'allowed' })).toEqual([]);
    expect(claudeRateLimitWindows({ status: 'allowed', rateLimitType: 'five_hour' })).toEqual([]);
    expect(claudeRateLimitWindows({ rateLimitType: 'overage', utilization: 0.5 })).toEqual([]);
    expect(claudeRateLimitWindows(undefined)).toEqual([]);
  });

  it('drops the overage-included bucket, which names no window of its own', () => {
    expect(claudeRateLimitWindows({ status: 'allowed', rateLimitType: 'seven_day_overage_included', utilization: 0.4 })).toEqual([]);
  });

  it('reads a utilization well past 1 as a percentage already, and says so', () => {
    const told: unknown[] = [];
    expect(
      claudeRateLimitWindows({ status: 'allowed', rateLimitType: 'seven_day', utilization: 85 }, detail => told.push(detail))[0],
    ).toMatchObject({ id: 'seven_day', usedPercent: 85 });
    expect(told).toEqual([{ windowId: 'seven_day', value: 85 }]);
    // A used-up window may read a little over 1: still a fraction.
    expect(claudeRateLimitWindows({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1.01 }, () => told.push('x'))[0]).toMatchObject({
      usedPercent: 100,
    });
    expect(told).toHaveLength(1);
  });
});

describe('claudeOAuthUsageToLimits', () => {
  it("reads the usage endpoint's windows (0–100) and its model-scoped caps", () => {
    const limits = claudeOAuthUsageToLimits(
      {
        five_hour: { utilization: 37, resets_at: '2026-11-11T20:00:00Z' },
        seven_day: { utilization: 12.5, resets_at: '2026-11-15T08:00:00Z' },
        seven_day_opus: null,
        model_scoped: [{ display_name: 'Fable 5.2', utilization: 4, resets_at: null }],
      },
      '2026-11-11T18:00:00.000Z',
    );
    expect(limits).toEqual({
      checkedAt: '2026-11-11T18:00:00.000Z',
      source: 'probe',
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 37, windowDurationMins: 300, resetsAt: '2026-11-11T20:00:00.000Z' },
        { id: 'seven_day', kind: 'weekly', usedPercent: 12.5, windowDurationMins: 10080, resetsAt: '2026-11-15T08:00:00.000Z' },
        { id: 'seven_day_fable_5_2', kind: 'model', label: 'Fable 5.2', usedPercent: 4, windowDurationMins: 10080 },
      ],
    });
  });

  it('clamps a window past its allowance and skips one without utilization', () => {
    expect(
      claudeOAuthUsageToLimits({ five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 250, resets_at: null } }, checkedAt)
        .windows,
    ).toEqual([{ id: 'seven_day', kind: 'weekly', usedPercent: 100, windowDurationMins: 10080 }]);
  });

  const enterprise = {
    five_hour: null,
    seven_day: null,
    spend: {
      enabled: true,
      used: { amount_minor: 4_631, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 50_000, currency: 'USD', exponent: 2 },
      percent: 9,
    },
    extra_usage: { is_enabled: true, used_credits: 4_631, monthly_limit: 50_000, utilization: 9.261999999999999, currency: 'USD' },
  };
  const spendWindow = { id: 'monthly_spend', kind: 'spend', usedPercent: expect.closeTo(9.262, 10) };

  it('reads the spend budget precisely, beside the rolling windows', () => {
    expect(claudeOAuthUsageToLimits(enterprise, checkedAt)).toEqual({ checkedAt, source: 'probe', windows: [spendWindow] });
    const withSession = {
      ...enterprise,
      five_hour: { utilization: 12, resets_at: null },
      extra_usage: { ...enterprise.extra_usage, used_credits: 30_000, utilization: 60 },
    };
    expect(claudeOAuthUsageToLimits(withSession, checkedAt).windows).toEqual([
      { id: 'five_hour', kind: 'session', usedPercent: 12, windowDurationMins: 300 },
      spendWindow,
    ]);
  });

  it('falls back to enabled extra usage amounts, then its utilization, when spend is unusable', () => {
    const disabledSpend = {
      ...enterprise,
      spend: { ...enterprise.spend, enabled: false, used: { amount_minor: 30_000, currency: 'USD', exponent: 2 } },
      extra_usage: { ...enterprise.extra_usage, utilization: 9 },
    };
    expect(claudeOAuthUsageToLimits(disabledSpend, checkedAt).windows).toEqual([spendWindow]);
    const utilizationOnly = {
      ...disabledSpend,
      spend: { enabled: true, used: null, limit: null, percent: 9 },
      extra_usage: { ...enterprise.extra_usage, used_credits: null, monthly_limit: null },
    };
    expect(claudeOAuthUsageToLimits(utilizationOnly, checkedAt).windows).toEqual([spendWindow]);
  });

  it('shows no budget when both are off, or the money does not add up without a fallback', () => {
    const off = { ...enterprise, spend: { ...enterprise.spend, enabled: false }, extra_usage: { ...enterprise.extra_usage, is_enabled: false } };
    expect(claudeOAuthUsageToLimits(off, checkedAt).windows).toEqual([]);
    const otherCurrency = { ...off, spend: { ...enterprise.spend, limit: { ...enterprise.spend.limit, currency: 'EUR' } } };
    expect(claudeOAuthUsageToLimits(otherCurrency, checkedAt).windows).toEqual([]);
    const noLimit = { ...off, spend: { ...enterprise.spend, limit: { ...enterprise.spend.limit, amount_minor: 0 } } };
    expect(claudeOAuthUsageToLimits(noLimit, checkedAt).windows).toEqual([]);
  });

  it('marks an account without windows as unsupported', () => {
    expect(claudeOAuthUsageToLimits({}, 'now').unavailable).toEqual({ reason: 'unsupported' });
    expect(claudeOAuthUsageToLimits('nope', 'now').unavailable?.reason).toBe('failed');
  });
});

describe('ClaudeCodeSession usage limits', () => {
  it("emits the turn's allowance windows with the account it runs on", async () => {
    const lines = fixture('turn-complete.jsonl');
    const rateLimit = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: RESET },
      session_id: '9f0c1a52-6b1e-4d6a-9a43-2f3b8f0e7c11',
    });
    const fake = fakeClaude([{ lines: [lines[0]!, rateLimit, ...lines.slice(1)] }]);
    const harness = createClaudeCodeHarness({
      store: createInMemorySessionStore(),
      spawn: fake.spawn,
      credentials: async () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'token' }, accountId: 'acc-1' }),
      cwdFor: () => WORKDIR,
      env: { PATH: '/usr/bin' },
    });
    const session = await harness.createSession({ sessionId: 'card-1', threadId: 'thread-1', resourceId: 'fp-1' });
    const events: AgentEvent[] = [];
    const ended = new Promise<void>(resolve =>
      session.subscribe(event => {
        events.push(event);
        if (event.type === 'agent_end') resolve();
      }),
    );
    const requestContext = harness.runContext(session, { userId: 'u', orgId: 'o', threadId: 'thread-1', resourceId: 'fp-1' });
    await session.sendSignal({ id: 'k1', type: 'user', tagName: 'user', contents: 'Go.' }, { requestContext, requireDelivery: true })
      .accepted;
    await ended;

    const update = events.find(event => (event.type as string) === 'usage_limits_update') as unknown as Record<string, unknown>;
    expect(update).toMatchObject({
      accountId: 'acc-1',
      windows: [{ id: 'five_hour', usedPercent: 90 }],
      checkedAt: expect.any(String),
    });
    expect(session.accountId).toBe('acc-1');
  });
});
