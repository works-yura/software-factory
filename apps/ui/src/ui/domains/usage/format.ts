import type { UsageAggregate, UsageWindow } from '@factory/harness/usage';

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

/** The window's name: 5-hour, weekly, monthly, or a model's weekly cap. */
export function windowLabel(window: Pick<UsageWindow, 'kind' | 'label'>): string {
  if (window.kind === 'model') return window.label ? tu('window.model', { label: window.label }) : tu('window.modelUnnamed');
  return tu(`window.${window.kind}`);
}

/** Windows in reading order: the 5-hour session, the week, the models, the month. */
export function orderedWindows(windows: ReadonlyArray<UsageWindow>): UsageWindow[] {
  const rank: Record<UsageWindow['kind'], number> = { session: 0, weekly: 1, model: 2, monthly: 3 };
  return [...windows].sort((a, b) => rank[a.kind] - rank[b.kind] || (a.label ?? a.id).localeCompare(b.label ?? b.id));
}

export function harnessName(harnessId: string): string {
  const known = ['claude-code', 'codex', 'mastra'];
  return known.includes(harnessId) ? tu(`harness.${harnessId}`) : harnessId;
}
