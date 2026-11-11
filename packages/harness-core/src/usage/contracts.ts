// The usage data every turn harness reports, in one shape: subscription windows (how much of an
// account's 5-hour, weekly or model allowance is used, and when it resets) and token counts (what a
// turn spent). Browser-safe: the server stores and serves these, the UI reads them as they are.
import type { AgentTokenUsage } from '../contract.ts';

/** How long a window runs: a 5-hour session, a week, a month; `model` for a model-specific weekly cap. */
export type UsageWindowKind = 'session' | 'weekly' | 'monthly' | 'model';

/** One allowance window of an account, as its provider reports it. */
export interface UsageWindow {
  /** Stable per account (`five_hour`, `seven_day`, `primary`, …), so updates replace the same row. */
  readonly id: string;
  readonly kind: UsageWindowKind;
  /** The provider's name for a model-specific window (`Opus`), when it gives one. */
  readonly label?: string;
  /** 0–100. */
  readonly usedPercent: number;
  readonly windowDurationMins?: number;
  /** ISO time the window resets. */
  readonly resetsAt?: string;
}

/** An account's allowance as last read: from a probe of the provider, or from a turn's stream. */
export interface AccountUsageLimits {
  /** ISO time the provider said this. */
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<UsageWindow>;
  /** Where it came from: a probe the Factory made, or what a running turn was told. */
  readonly source: 'probe' | 'stream';
  /** Set when the provider has no windows for this account (an API key, a plan without them) or the probe failed. */
  readonly unavailable?: { readonly reason: 'unsupported' | 'failed' | 'signed_out'; readonly message?: string };
}

/**
 * Not part of the runtime's events: a harness emits it beside them when its provider tells a running
 * turn how much of the account's allowance is used (Claude's `rate_limit_event`, Codex's
 * `account/rateLimits/updated`). Only the windows it names change.
 */
export interface UsageLimitsUpdateEvent {
  readonly type: 'usage_limits_update';
  /** The account the turn runs on, when the harness knows it. */
  readonly accountId?: string;
  readonly windows: ReadonlyArray<UsageWindow>;
  /** ISO time the update was seen. */
  readonly checkedAt: string;
}

export function isUsageLimitsUpdateEvent(event: { type: string }): event is UsageLimitsUpdateEvent {
  return event.type === 'usage_limits_update' && Array.isArray((event as Partial<UsageLimitsUpdateEvent>).windows);
}

/** Folds an update into what was known: windows it names replace theirs, the rest stay. */
export function mergeUsageWindows(
  previous: ReadonlyArray<UsageWindow>,
  update: ReadonlyArray<UsageWindow>,
): UsageWindow[] {
  const byId = new Map(previous.map(window => [window.id, window]));
  for (const window of update) byId.set(window.id, window);
  return [...byId.values()];
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** ISO time from epoch seconds (or milliseconds, for values that can only be milliseconds). */
export function isoFromEpoch(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** ISO time from a date string, or `undefined` when it is not one. */
export function isoFromString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Token counts split by how they are billed. `inputTokens` is the uncached input alone; cache reads
 * and writes are their own; `outputTokens` includes `reasoningTokens` (never charged twice).
 */
export interface UsageTokenTotals {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export function emptyTokenTotals(): UsageTokenTotals {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

export function addTokenTotals(total: UsageTokenTotals, step: UsageTokenTotals): UsageTokenTotals {
  return {
    inputTokens: total.inputTokens + step.inputTokens,
    cacheReadTokens: total.cacheReadTokens + step.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + step.cacheWriteTokens,
    outputTokens: total.outputTokens + step.outputTokens,
    reasoningTokens: total.reasoningTokens + step.reasoningTokens,
  };
}

/** Every token the totals count: input of every kind and output. */
export function totalTokens(totals: UsageTokenTotals): number {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens;
}

const count = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * A harness step's usage split by billing. The contract's `promptTokens` counts cache reads and
 * writes inside it (Claude Code and Codex both report it so), so the uncached input is what is left.
 */
export function tokenTotalsOf(usage: AgentTokenUsage): UsageTokenTotals {
  const prompt = count(usage.promptTokens);
  const cacheRead = Math.min(prompt, count(usage.cachedInputTokens));
  const cacheWrite = Math.min(prompt - cacheRead, count(usage.cacheCreationInputTokens));
  const output = count(usage.completionTokens);
  return {
    inputTokens: prompt - cacheRead - cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: Math.min(output, count(usage.reasoningTokens)),
  };
}

/** How a turn's cost is known: the provider said it, the rate table priced it, or neither. */
export type UsageCostSource = 'reported' | 'estimated' | 'unpriced';

/** One turn as the usage store keeps it and the API serves it. */
export interface UsageTurn {
  id: string;
  sessionId: string;
  threadId: string | null;
  runId: string | null;
  factoryProjectId: string | null;
  workItemId: string | null;
  /** The card run (kickoff) the turn belonged to, when it was one. */
  kickoffId: string | null;
  /**
   * The role that run played (`implementer`, `reviewer`, …): what a run's `factory.run.ended`
   * audit record names beside its usage. `null` outside a card run, and on turns recorded before
   * roles were.
   */
  role: string | null;
  userId: string | null;
  harnessId: string;
  model: string | null;
  accountId: string | null;
  /** ISO time the turn ended. */
  occurredAt: string;
  totals: UsageTokenTotals;
  /** Model calls in the turn. */
  stepCount: number;
  /** The input of the turn's last model call: how full its context was. */
  contextTokens: number | null;
  /** The provider's own figure for the turn, when it gave one (Claude Code's `total_cost_usd`). */
  reportedCostUsd: number | null;
}
