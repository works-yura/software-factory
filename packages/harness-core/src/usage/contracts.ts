// The usage data every turn harness reports, in one shape: subscription windows (how much of an
// account's 5-hour, weekly or model allowance is used, and when it resets) and token counts (what a
// turn spent). Browser-safe: the server stores and serves these, the UI reads them as they are.
import type { AgentTokenUsage } from '../contract.ts';

/**
 * How long a window runs: a 5-hour session, a week, a month; `model` for a model-specific weekly cap;
 * `spend` for a paid budget on top of the plan (extra usage, a monthly spend limit).
 */
export type UsageWindowKind = 'session' | 'weekly' | 'monthly' | 'model' | 'spend';

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

/**
 * Folds an update into what was known: windows it names replace theirs, the rest stay. A reset time
 * or length the update leaves out keeps the known one, and a reading in the wrong unit is put right
 * (`reconcileUsageWindow`).
 */
export function mergeUsageWindows(
  previous: ReadonlyArray<UsageWindow>,
  update: ReadonlyArray<UsageWindow>,
): UsageWindow[] {
  const byId = new Map(previous.map(window => [window.id, window]));
  for (const window of update) {
    const known = byId.get(window.id);
    const next: UsageWindow = {
      ...window,
      ...(window.resetsAt === undefined && known?.resetsAt !== undefined ? { resetsAt: known.resetsAt } : {}),
      ...(window.windowDurationMins === undefined && known?.windowDurationMins !== undefined
        ? { windowDurationMins: known.windowDurationMins }
        : {}),
    };
    byId.set(window.id, reconcileUsageWindow(known, next).window);
  }
  return [...byId.values()];
}

/** Every window of `next`, each put right against the same window in `previous` (`reconcileUsageWindow`). */
export function reconcileUsageWindows(
  previous: ReadonlyArray<UsageWindow>,
  next: ReadonlyArray<UsageWindow>,
): { windows: UsageWindow[]; suspectedUnitChange: string[] } {
  const byId = new Map(previous.map(window => [window.id, window]));
  const suspectedUnitChange: string[] = [];
  const windows = next.map(window => {
    const reconciled = reconcileUsageWindow(byId.get(window.id), window);
    if (reconciled.suspectedUnitChange) suspectedUnitChange.push(window.id);
    return reconciled.window;
  });
  return { windows, suspectedUnitChange };
}

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

/** A fraction as a percentage, without the float noise of `0.55 * 100`. */
const scaleFraction = (value: number) => Math.round(value * 100 * 1e6) / 1e6;

/** Usage only grows inside one window period, so a reset this close to the known one is the same period. */
const SAME_PERIOD_MS = 60 * 60_000;
/** A known reading below this tells nothing about a fraction (0.9 % and 0.009 look alike). */
const UNIT_GUARD_MIN_PERCENT = 5;
/** How far a reading may fall inside one period before it is taken at its word (rounding, a recount). */
const UNIT_GUARD_SLACK_PERCENT = 2;

/**
 * A provider's percentage as 0–100. Sources disagree on the unit: Claude's stream says 0–1, its usage
 * endpoint and Codex say 0–100. `fraction` scales a 0–1 value; a value well past 1 cannot be a
 * fraction of the allowance (a used-up window reads 1, an overrun a little more), so it is taken as
 * a percentage already and flagged as a suspected unit change.
 */
export function normalizeUsedPercent(
  value: number,
  unit: 'fraction' | 'percent',
): { usedPercent: number; suspectedUnitChange: boolean } {
  if (!Number.isFinite(value)) return { usedPercent: 0, suspectedUnitChange: false };
  if (unit === 'percent') return { usedPercent: clampPercent(value), suspectedUnitChange: false };
  if (value > 1.5) return { usedPercent: clampPercent(value), suspectedUnitChange: true };
  return { usedPercent: clampPercent(scaleFraction(value)), suspectedUnitChange: false };
}

/**
 * A new reading of a window against the last one: a 0–100 source that sent a fraction shows as
 * almost nothing used where the window was well into its allowance. Inside one period usage never
 * falls, so a reading at most 1 % in the same period (both reset times agree) whose hundredfold
 * reaches the known value is that value: it is scaled back and flagged.
 */
export function reconcileUsageWindow(
  previous: UsageWindow | undefined,
  next: UsageWindow,
): { window: UsageWindow; suspectedUnitChange: boolean } {
  if (!previous || previous.usedPercent < UNIT_GUARD_MIN_PERCENT || next.usedPercent > 1 || next.usedPercent <= 0) {
    return { window: next, suspectedUnitChange: false };
  }
  const known = previous.resetsAt ? Date.parse(previous.resetsAt) : Number.NaN;
  const told = next.resetsAt ? Date.parse(next.resetsAt) : Number.NaN;
  // Without both reset times a fall could be a reset, which the guard must not undo.
  const samePeriod = !Number.isNaN(told) && !Number.isNaN(known) && Math.abs(told - known) <= SAME_PERIOD_MS;
  const scaled = scaleFraction(next.usedPercent);
  if (!samePeriod || scaled < previous.usedPercent - UNIT_GUARD_SLACK_PERCENT) {
    return { window: next, suspectedUnitChange: false };
  }
  return { window: { ...next, usedPercent: clampPercent(scaled) }, suspectedUnitChange: true };
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
