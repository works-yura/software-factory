import { describe, expect, it } from 'vitest';

import type { UsageTokenTotals } from './contracts.ts';
import { cacheSavingsUsd, createRateTable, DEFAULT_RATE_TABLE, lookupRate, modelContextWindow, priceUsage } from './pricing.ts';

const totals = (overrides: Partial<UsageTokenTotals> = {}): UsageTokenTotals => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  ...overrides,
});

const table = createRateTable({
  'model-a': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5, fast: 2 },
  'model-b': { input: 1, output: 4 },
});

describe('usage pricing', () => {
  it('prices each category at its own rate and leaves reasoning inside output', () => {
    const priced = priceUsage(
      {
        model: 'model-a',
        totals: totals({ inputTokens: 1_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 400_000 }),
      },
      table,
    );
    expect(priced.costSource).toBe('estimated');
    expect(priced.categoryCostUsd).toEqual({ input: 2, cacheRead: 1, cacheWrite: 2.5, output: 8 });
    expect(priced.costUsd).toBeCloseTo(13.5);
  });

  it('defaults cache reads to a tenth of input and 5-minute writes to 1.25×', () => {
    const priced = priceUsage({ model: 'model-b', totals: totals({ cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }) }, table);
    expect(priced.categoryCostUsd?.cacheRead).toBeCloseTo(0.1);
    expect(priced.categoryCostUsd?.cacheWrite).toBeCloseTo(1.25);
  });

  it("prices fast-mode turns at the model's published fast multiple", () => {
    const standard = priceUsage({ model: 'model-a', totals: totals({ outputTokens: 1_000_000 }) }, table);
    const fast = priceUsage({ model: 'model-a', totals: totals({ outputTokens: 1_000_000 }), speed: 'fast' }, table);
    expect(fast.costUsd).toBeCloseTo(standard.costUsd * 2);
    // A model without a fast tier prices fast turns at its standard rate.
    expect(priceUsage({ model: 'model-b', totals: totals({ outputTokens: 1_000_000 }), speed: 'fast' }, table).costUsd).toBeCloseTo(4);
  });

  it("prefers the provider's reported cost and splits it in the table's proportions", () => {
    const priced = priceUsage({ model: 'model-b', totals: totals({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), reportedCostUsd: 2.5 }, table);
    expect(priced).toMatchObject({ costUsd: 2.5, costSource: 'reported' });
    expect(priced.categoryCostUsd?.input).toBeCloseTo(0.5);
    expect(priced.categoryCostUsd?.output).toBeCloseTo(2);
    expect(priceUsage({ model: 'unknown-model', totals: totals({ outputTokens: 10 }), reportedCostUsd: 0.3 }, table)).toEqual({
      costUsd: 0.3,
      costSource: 'reported',
      categoryCostUsd: null,
    });
  });

  it('leaves unknown models, bare family names and synthetic messages unpriced instead of free', () => {
    for (const model of ['some-new-model', 'opus', 'sonnet', '<synthetic>', null]) {
      expect(priceUsage({ model, totals: totals({ outputTokens: 1000 }) }, DEFAULT_RATE_TABLE)).toEqual({
        costUsd: 0,
        costSource: 'unpriced',
        categoryCostUsd: null,
      });
    }
  });

  it('finds a rate through context variants, provider prefixes, platform ids and dated snapshots', () => {
    const base = lookupRate(DEFAULT_RATE_TABLE, 'claude-opus-4-6');
    expect(base).not.toBeNull();
    for (const name of ['claude-opus-4-6[1m]', 'anthropic/claude-opus-4-6', 'us.anthropic.claude-opus-4-6-v1:0', 'Claude-Opus-4-6 ']) {
      expect(lookupRate(DEFAULT_RATE_TABLE, name)).toBe(base);
    }
    expect(lookupRate(DEFAULT_RATE_TABLE, 'claude-haiku-4-5-20251001')).toBe(lookupRate(DEFAULT_RATE_TABLE, 'claude-haiku-4-5'));
    expect(lookupRate(DEFAULT_RATE_TABLE, 'openai/gpt-5.1-codex')).toBe(lookupRate(DEFAULT_RATE_TABLE, 'gpt-5.1-codex'));
  });

  it('prices current Claude models at their list rates, cache reads included', () => {
    const priced = priceUsage(
      { model: 'claude-opus-5-5', totals: totals({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }) },
      DEFAULT_RATE_TABLE,
    );
    expect(priced.categoryCostUsd?.input).toBeCloseTo(4);
    expect(priced.categoryCostUsd?.cacheRead).toBeCloseTo(0.2);
    expect(priced.categoryCostUsd?.output).toBeCloseTo(20);
  });

  it('knows context windows, and a `[1m]` variant runs with a million tokens', () => {
    expect(modelContextWindow('claude-haiku-4-5')).toBe(200_000);
    expect(modelContextWindow('claude-sonnet-4-5[1m]')).toBe(1_000_000);
    expect(modelContextWindow('gpt-5.1-codex')).toBe(400_000);
    expect(modelContextWindow('mystery')).toBeUndefined();
    expect(modelContextWindow(null)).toBeUndefined();
  });

  it('values cache reads at what full input would have cost', () => {
    expect(cacheSavingsUsd({ model: 'model-a', totals: totals({ cacheReadTokens: 1_000_000 }) }, table)).toBeCloseTo(1.5);
    expect(cacheSavingsUsd({ model: 'unknown', totals: totals({ cacheReadTokens: 1_000_000 }) }, table)).toBe(0);
  });
});
