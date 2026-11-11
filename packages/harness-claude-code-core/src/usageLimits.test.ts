import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@factory/harness';

import { fakeClaude, fixture } from './__fixtures__/fake-claude.ts';
import { createClaudeCodeHarness } from './harness.ts';
import { createInMemorySessionStore } from './store.ts';
import { claudeOAuthUsageToLimits, claudeRateLimitWindows } from './usageLimits.ts';

const RESET = 1_793_000_000;

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
      cwdFor: () => '/work/card-1',
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
