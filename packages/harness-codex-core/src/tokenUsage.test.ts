import { describe, expect, it } from 'vitest';

import { accumulateCodexTurnTokenUsage, completeCodexTurnTokenUsage, makeCodexTurnTokenUsageState } from './tokenUsage.ts';

const breakdown = (input: number, cached: number, output: number, reasoning: number) => ({
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
  totalTokens: input + output,
});

describe('Codex turn token usage', () => {
  it("counts what the thread's totals grew by while the turn ran", () => {
    const state = makeCodexTurnTokenUsageState();
    // A total from an earlier turn only moves the baseline.
    accumulateCodexTurnTokenUsage(state, 'old', { total: breakdown(100, 50, 10, 2), last: breakdown(100, 50, 10, 2) });
    state.activeTurnId = 'turn';
    const step = accumulateCodexTurnTokenUsage(state, 'turn', { total: breakdown(160, 80, 30, 7), last: breakdown(60, 30, 20, 5) });
    expect(step).toEqual({ inputTokens: 60, cachedInputTokens: 30, outputTokens: 20, reasoningTokens: 5 });
    accumulateCodexTurnTokenUsage(state, 'turn', { total: breakdown(200, 100, 40, 9), last: breakdown(40, 20, 10, 2) });
    expect(completeCodexTurnTokenUsage(state, 'turn')).toEqual({
      promptTokens: 100,
      completionTokens: 30,
      totalTokens: 130,
      cachedInputTokens: 50,
      reasoningTokens: 7,
    });
    expect(state.activeTurnId).toBeUndefined();
  });

  it("takes the newest response's usage when the totals went backwards", () => {
    const state = makeCodexTurnTokenUsageState();
    accumulateCodexTurnTokenUsage(state, 'old', { total: breakdown(500, 0, 50, 0), last: breakdown(500, 0, 50, 0) });
    state.activeTurnId = 'turn';
    expect(accumulateCodexTurnTokenUsage(state, 'turn', { total: breakdown(20, 0, 5, 0), last: breakdown(20, 0, 5, 0) })).toEqual({
      inputTokens: 20,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    });
  });

  it('reports nothing for a turn Codex sent no usage for', () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = 'turn';
    expect(completeCodexTurnTokenUsage(state, 'turn')).toBeUndefined();
  });
});
