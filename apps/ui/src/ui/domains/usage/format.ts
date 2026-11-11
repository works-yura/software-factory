import type { UsageAggregate, UsageWindow } from '@factory/harness/usage';
import { orderUsageWindows, usageResetsInMs, usageWindowPace } from '@factory/harness/usage';

import { currentLanguage } from '../../i18n';
import { translator } from '../../i18n/t';

const tu = translator('usage');

/** Tokens in the compact form the status line uses: 950, 12.3K, 4.1M. */
export function formatTokens(value: number): string {
  return new Intl.NumberFormat(currentLanguage(), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** A dollar figure: cents for most, more digits for a fraction of a cent, `<$0.01` below. */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `<${new Intl.NumberFormat(currentLanguage(), { style: 'currency', currency: 'USD' }).format(0.01)}`;
  return new Intl.NumberFormat(currentLanguage(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** An aggregate's cost as read beside its tokens: the estimate, or that its models have no price. */
export function formatAggregateCost(aggregate: Pick<UsageAggregate, 'costUsd' | 'turns' | 'unpricedTurns'>): string {
  if (aggregate.turns > 0 && aggregate.unpricedTurns === aggregate.turns) return tu('cost.unpriced');
  return tu('cost.estimate', { cost: formatUsd(aggregate.costUsd) });
}

export function formatUsageTime(iso: string): string {
  return new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/** The window's name: 5-hour, weekly, monthly, a model's weekly cap, or extra usage. */
export function windowLabel(window: Pick<UsageWindow, 'kind' | 'label'>): string {
  if (window.kind === 'model') return window.label ? tu('window.model', { label: window.label }) : tu('window.modelUnnamed');
  return tu(`window.${window.kind}`);
}

/** Windows in reading order: the 5-hour session, the week, the models, the month, extra usage. */
export function orderedWindows(windows: ReadonlyArray<UsageWindow>): UsageWindow[] {
  return orderUsageWindows(windows);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A span as the two largest units: `2d 4h`, `3h 12m`, `8m`. */
export function formatDuration(ms: number): string {
  const left = Math.max(0, ms);
  const days = Math.floor(left / DAY_MS);
  const hours = Math.floor((left % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((left % HOUR_MS) / MINUTE_MS);
  if (days > 0) return tu('duration.days', { days, hours });
  if (hours > 0) return tu('duration.hours', { hours, minutes });
  return tu('duration.minutes', { minutes: Math.max(1, minutes) });
}

/** When the window resets, counted down (`resets in 2h 10m`); `undefined` without a reset time. */
export function formatResetsIn(window: UsageWindow, now: number): string | undefined {
  const left = usageResetsInMs(window, now);
  if (left === null) return undefined;
  return left === 0 ? tu('resetsNow') : tu('resetsIn', { duration: formatDuration(left) });
}

/**
 * A window's second line: its countdown, the reset time itself, and a word when spending runs ahead
 * of the clock.
 */
export function windowDetail(window: UsageWindow, now: number): string | undefined {
  const parts: string[] = [];
  const resetsIn = formatResetsIn(window, now);
  if (resetsIn) parts.push(resetsIn);
  if (window.resetsAt && usageResetsInMs(window, now)) parts.push(formatUsageTime(window.resetsAt));
  if (usageWindowPace(window, now) === 'ahead') parts.push(tu('pace.ahead'));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function harnessName(harnessId: string): string {
  const known = ['claude-code', 'codex', 'mastra'];
  return known.includes(harnessId) ? tu(`harness.${harnessId}`) : harnessId;
}
