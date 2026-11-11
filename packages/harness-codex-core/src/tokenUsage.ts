// A turn's token usage. Codex reports thread-wide totals (`total`) and the newest model response
// (`last`) after each response; the turn's own usage is what the totals grew by while it ran.
import type { AgentTokenUsage } from '@factory/harness';

import type { ThreadTokenUsage, TokenUsageBreakdown } from './protocol/schema.ts';

interface CodexCumulativeTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens?: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

interface CodexTurnTokenUsageAccumulator {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number | undefined;
  outputTokens: number;
  reasoningTokens: number;
  observed: boolean;
}

export interface CodexTurnTokenUsageState {
  baseline: CodexCumulativeTokenUsage | undefined;
  activeTurnId: string | undefined;
  readonly byTurnId: Map<string, CodexTurnTokenUsageAccumulator>;
}

function codexTokenUsageBreakdown(usage: TokenUsageBreakdown): CodexCumulativeTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheCreationTokens: usage.cacheWriteInputTokens } : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
  };
}

export function makeCodexTurnTokenUsageState(): CodexTurnTokenUsageState {
  return { baseline: undefined, activeTurnId: undefined, byTurnId: new Map() };
}

export function getCodexTurnAccumulator(state: CodexTurnTokenUsageState, turnId: string): CodexTurnTokenUsageAccumulator {
  const existing = state.byTurnId.get(turnId);
  if (existing) return existing;
  const created: CodexTurnTokenUsageAccumulator = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    observed: false,
  };
  state.byTurnId.set(turnId, created);
  return created;
}

/** total is thread-wide; last covers the newest model response. */
function codexTurnTokenUsageDelta(
  previous: CodexCumulativeTokenUsage | undefined,
  current: CodexCumulativeTokenUsage,
  last: CodexCumulativeTokenUsage,
): CodexCumulativeTokenUsage {
  if (
    previous === undefined ||
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens
  ) {
    return last;
  }
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    ...(current.cacheCreationTokens !== undefined &&
    previous.cacheCreationTokens !== undefined &&
    current.cacheCreationTokens >= previous.cacheCreationTokens
      ? { cacheCreationTokens: current.cacheCreationTokens - previous.cacheCreationTokens }
      : {}),
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
  };
}

/**
 * Folds a `thread/tokenUsage/updated` into the turn's usage and returns what this update added
 * (a `usage_update` step), or `undefined` when it added nothing or belongs to another turn.
 */
export function accumulateCodexTurnTokenUsage(
  state: CodexTurnTokenUsageState,
  turnId: string,
  usage: ThreadTokenUsage,
): CodexCumulativeTokenUsage | undefined {
  const current = codexTokenUsageBreakdown(usage.total);
  if (state.activeTurnId !== turnId) {
    // Every thread-wide total updates the baseline; late finished-turn updates do not count toward the live turn.
    state.baseline = current;
    return undefined;
  }

  const accumulator = getCodexTurnAccumulator(state, turnId);
  const delta = codexTurnTokenUsageDelta(state.baseline, current, codexTokenUsageBreakdown(usage.last));
  state.baseline = current;

  const grew = delta.inputTokens > 0 || delta.cachedInputTokens > 0 || delta.outputTokens > 0 || delta.reasoningTokens > 0;
  if (grew) accumulator.observed = true;
  accumulator.inputTokens += delta.inputTokens;
  accumulator.cachedInputTokens += delta.cachedInputTokens;
  accumulator.outputTokens += delta.outputTokens;
  accumulator.reasoningTokens += delta.reasoningTokens;
  if (delta.cacheCreationTokens === undefined) {
    accumulator.cacheCreationTokens = undefined;
  } else if (accumulator.cacheCreationTokens !== undefined) {
    accumulator.cacheCreationTokens += delta.cacheCreationTokens;
  }
  return grew ? delta : undefined;
}

/** The turn is over: forgets it and returns its total, or `undefined` when Codex reported none. */
export function completeCodexTurnTokenUsage(state: CodexTurnTokenUsageState, turnId: string): AgentTokenUsage | undefined {
  const usage = state.byTurnId.get(turnId);
  state.byTurnId.delete(turnId);
  if (state.activeTurnId === turnId) state.activeTurnId = undefined;
  if (!usage?.observed) return undefined;
  return toAgentTokenUsage(usage);
}

/** Codex counts cache reads and writes inside `inputTokens`, as the contract's `promptTokens` does. */
export function toAgentTokenUsage(usage: CodexCumulativeTokenUsage | CodexTurnTokenUsageAccumulator): AgentTokenUsage {
  const result: AgentTokenUsage = {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cachedInputTokens: Math.min(usage.inputTokens, usage.cachedInputTokens),
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
  };
  if (usage.cacheCreationTokens !== undefined) {
    result.cacheCreationInputTokens = Math.min(usage.inputTokens, usage.cacheCreationTokens);
  }
  return result;
}
