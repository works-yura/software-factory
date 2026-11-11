import { describe, expect, it } from 'vitest';

import { summarizeSessionUsage, summarizeUsage, summarizeWorkItemUsage, USAGE_TOP_SESSIONS } from './aggregate.ts';
import type { UsageTurn } from './contracts.ts';
import { isUsageLimitsUpdateEvent, mergeUsageWindows, tokenTotalsOf } from './contracts.ts';
import { createRateTable } from './pricing.ts';
import { createHarnessUsageRegistry } from './facet.ts';

const table = createRateTable({ 'model-a': { input: 1, output: 2 } });

function turn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    sessionId: 's1',
    threadId: 't1',
    runId: null,
    factoryProjectId: 'f1',
    workItemId: null,
    kickoffId: null,
    role: null,
    userId: 'u1',
    harnessId: 'claude-code',
    model: 'model-a',
    accountId: 'acc-1',
    occurredAt: '2026-11-02T10:00:00.000Z',
    totals: { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500_000, reasoningTokens: 0 },
    stepCount: 1,
    contextTokens: 1_000_000,
    reportedCostUsd: null,
    ...overrides,
  };
}

describe('tokenTotalsOf', () => {
  it('splits a step so cache reads and writes are not counted as uncached input too', () => {
    expect(
      tokenTotalsOf({ promptTokens: 1000, completionTokens: 300, cachedInputTokens: 600, cacheCreationInputTokens: 100, reasoningTokens: 50 }),
    ).toEqual({ inputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 300, reasoningTokens: 50 });
    // Inconsistent counts never go negative.
    expect(tokenTotalsOf({ promptTokens: 10, cachedInputTokens: 50, completionTokens: 1, reasoningTokens: 9 })).toEqual({
      inputTokens: 0,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      outputTokens: 1,
      reasoningTokens: 1,
    });
  });
});

describe('usage windows', () => {
  it('replaces the windows an update names and keeps the rest', () => {
    const merged = mergeUsageWindows(
      [
        { id: 'five_hour', kind: 'session', usedPercent: 10 },
        { id: 'seven_day', kind: 'weekly', usedPercent: 40 },
      ],
      [{ id: 'five_hour', kind: 'session', usedPercent: 55, resetsAt: '2026-11-02T15:00:00.000Z' }],
    );
    expect(merged).toEqual([
      { id: 'five_hour', kind: 'session', usedPercent: 55, resetsAt: '2026-11-02T15:00:00.000Z' },
      { id: 'seven_day', kind: 'weekly', usedPercent: 40 },
    ]);
    expect(isUsageLimitsUpdateEvent({ type: 'usage_limits_update', windows: [] } as never)).toBe(true);
    expect(isUsageLimitsUpdateEvent({ type: 'usage_update' })).toBe(false);
  });

  it('registers one usage facet per harness and finds it by provider', () => {
    const registry = createHarnessUsageRegistry([{ harnessId: 'codex', displayName: 'Codex', accountProvider: 'openai-codex' }]);
    expect(registry.forProvider('openai-codex')?.harnessId).toBe('codex');
    expect(() => registry.register({ harnessId: 'codex', displayName: 'Codex', accountProvider: 'x' })).toThrow();
  });
});

describe('summarizeUsage', () => {
  it('sums the period by day (gap-filled), harness, model, account and Factory, with unpriced turns counted apart', () => {
    const summary = summarizeUsage(
      [
        turn({ id: 'a' }),
        turn({ id: 'b', occurredAt: '2026-11-04T09:00:00.000Z', harnessId: 'codex', model: 'mystery', accountId: null }),
        turn({ id: 'c', reportedCostUsd: 0.25 }),
      ],
      { from: '2026-11-01', to: '2026-11-04' },
      table,
    );
    expect(summary.byDay.map(day => [day.day, day.turns])).toEqual([
      ['2026-11-01', 0],
      ['2026-11-02', 2],
      ['2026-11-03', 0],
      ['2026-11-04', 1],
    ]);
    expect(summary.total).toMatchObject({ turns: 3, unpricedTurns: 1, totalTokens: 4_500_000, reportedCostUsd: 0.25 });
    expect(summary.total.costUsd).toBeCloseTo(2 + 0.25);
    expect(summary.byHarness.map(group => [group.key, group.turns])).toEqual([
      ['claude-code', 2],
      ['codex', 1],
    ]);
    expect(summary.byModel.map(group => group.key)).toEqual(['model-a', 'mystery']);
    expect(summary.byAccount.map(group => group.key)).toEqual(['acc-1', '']);
    expect(summary.byFactory).toHaveLength(1);
  });

  it('splits by the role each card run played and ranks the sessions that spent most', () => {
    const summary = summarizeUsage(
      [
        turn({ id: 'a', sessionId: 's1', kickoffId: 'k1', role: 'implementer' }),
        turn({ id: 'b', sessionId: 's1', kickoffId: 'k1', role: 'implementer' }),
        turn({ id: 'c', sessionId: 's2', kickoffId: 'k2', role: 'reviewer', totals: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } }),
        turn({ id: 'd', sessionId: 's3' }),
      ],
      { from: '2026-11-02', to: '2026-11-02' },
      table,
    );
    expect(summary.byRole.map(group => [group.key, group.turns])).toEqual([
      ['implementer', 2],
      ['', 1],
      ['reviewer', 1],
    ]);
    expect(summary.bySession.map(group => group.key)).toEqual(['s1', 's3', 's2']);
  });

  it('ranks at most USAGE_TOP_SESSIONS sessions; the rest still count in the totals', () => {
    const turns = Array.from({ length: USAGE_TOP_SESSIONS + 5 }, (_, i) => turn({ id: `t${i}`, sessionId: `s${i}` }));
    const summary = summarizeUsage(turns, { from: '2026-11-02', to: '2026-11-02' }, table);
    expect(summary.bySession).toHaveLength(USAGE_TOP_SESSIONS);
    expect(summary.total.turns).toBe(USAGE_TOP_SESSIONS + 5);
  });
});

describe('summarizeSessionUsage', () => {
  it('lists turns oldest first with their prices and reads the context fill off the last turn', () => {
    const usage = summarizeSessionUsage(
      's1',
      [
        turn({ id: 'late', occurredAt: '2026-11-02T11:00:00.000Z', contextTokens: 42_000, model: 'claude-haiku-4-5' }),
        turn({ id: 'early', occurredAt: '2026-11-02T10:00:00.000Z' }),
      ],
      table,
    );
    expect(usage.turns.map(entry => entry.id)).toEqual(['early', 'late']);
    expect(usage.turns[0]).toMatchObject({ costSource: 'estimated', totalTokens: 1_500_000 });
    expect(usage.total.turns).toBe(2);
    expect(usage.context).toEqual({ tokens: 42_000, window: null });
  });
});

describe('summarizeWorkItemUsage', () => {
  it('groups a card’s turns into its runs, newest run first', () => {
    const usage = summarizeWorkItemUsage(
      'w1',
      [
        turn({ id: '1', workItemId: 'w1', kickoffId: 'k1', role: 'implementer', occurredAt: '2026-11-02T10:00:00.000Z' }),
        turn({ id: '2', workItemId: 'w1', kickoffId: 'k1', role: 'implementer', occurredAt: '2026-11-02T10:05:00.000Z' }),
        turn({ id: '3', workItemId: 'w1', kickoffId: 'k2', role: 'reviewer', occurredAt: '2026-11-03T10:00:00.000Z', harnessId: 'codex' }),
      ],
      table,
    );
    expect(usage.total.turns).toBe(3);
    expect(usage.runs.map(run => [run.kickoffId, run.role, run.turns, run.harnessId])).toEqual([
      ['k2', 'reviewer', 1, 'codex'],
      ['k1', 'implementer', 2, 'claude-code'],
    ]);
  });
});
