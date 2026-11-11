// A Claude subscription's allowance as usage windows: the 5-hour session, the week, the
// model-specific weekly caps, and extra usage (a monthly spend budget on top of the plan). Two
// sources say it: the CLI's `rate_limit_event` while a turn runs (utilization 0–1, reset as epoch
// seconds, one window per event), and the OAuth usage endpoint the CLI's own `/usage` reads
// (utilization 0–100, resets as ISO times, every window at once).
import type { AccountUsageLimits, UsageWindow, UsageWindowKind } from '@factory/harness/usage';
import { clampPercent, isoFromEpoch, isoFromString, normalizeUsedPercent } from '@factory/harness/usage';

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

interface KnownWindow {
  kind: UsageWindowKind;
  label?: string;
  windowDurationMins: number;
}

/** The windows Claude names, by the id both sources use. */
const CLAUDE_WINDOWS: Readonly<Record<string, KnownWindow>> = {
  five_hour: { kind: 'session', windowDurationMins: SESSION_MINS },
  seven_day: { kind: 'weekly', windowDurationMins: WEEK_MINS },
  seven_day_opus: { kind: 'model', label: 'Opus', windowDurationMins: WEEK_MINS },
  seven_day_sonnet: { kind: 'model', label: 'Sonnet', windowDurationMins: WEEK_MINS },
  seven_day_fable: { kind: 'model', label: 'Fable', windowDurationMins: WEEK_MINS },
};

function window(id: string, usedPercent: number, resetsAt: string | undefined, label?: string): UsageWindow | undefined {
  const known = CLAUDE_WINDOWS[id];
  if (!known) return undefined;
  const name = label ?? known.label;
  return {
    id,
    kind: known.kind,
    ...(name ? { label: name } : {}),
    usedPercent: clampPercent(usedPercent),
    windowDurationMins: known.windowDurationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Told when a reading came in a unit its source does not use (`normalizeUsedPercent`). */
export type SuspectedUnitChangeListener = (detail: { windowId: string; value: number }) => void;

const warnUnitChange: SuspectedUnitChangeListener = ({ windowId, value }) =>
  console.warn(`[Claude usage] ${windowId} utilization ${value} is not a 0–1 fraction; read as a percentage.`);

/**
 * The window a `rate_limit_event`'s `rate_limit_info` reports. Older CLIs send no utilization: a
 * rejected request then means the window is used up; an allowed one says nothing to show. A bucket
 * with no window of its own (`seven_day_overage_included`, which counts toward a model's cap the
 * stream does not name) is dropped: it would make a row no probe can reconcile.
 */
export function claudeRateLimitWindows(rateLimitInfo: unknown, onUnitChange: SuspectedUnitChangeListener = warnUnitChange): UsageWindow[] {
  const info = record(rateLimitInfo);
  if (!info) return [];
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : typeof info.rate_limit_type === 'string' ? info.rate_limit_type : undefined;
  if (!type || !CLAUDE_WINDOWS[type]) return [];
  const utilization = finite(info.utilization);
  const status = typeof info.status === 'string' ? info.status : undefined;
  let usedPercent: number | undefined;
  if (utilization !== undefined) {
    const normalized = normalizeUsedPercent(utilization, 'fraction');
    if (normalized.suspectedUnitChange) onUnitChange({ windowId: type, value: utilization });
    usedPercent = normalized.usedPercent;
  } else if (status === 'rejected') usedPercent = 100;
  if (usedPercent === undefined) return [];
  const made = window(type, usedPercent, isoFromEpoch(info.resetsAt ?? info.resets_at));
  return made ? [made] : [];
}

/**
 * The OAuth usage endpoint's answer (`GET /api/oauth/usage`): `five_hour`, `seven_day` and the
 * model windows, each `{ utilization, resets_at }` or null when the plan has none.
 */
export function claudeOAuthUsageToLimits(body: unknown, checkedAt: string): AccountUsageLimits {
  const usage = record(body);
  if (!usage) return { checkedAt, windows: [], source: 'probe', unavailable: { reason: 'failed', message: 'Claude sent no usage.' } };
  const windows: UsageWindow[] = [];
  for (const id of Object.keys(CLAUDE_WINDOWS)) {
    const entry = record(usage[id]);
    const utilization = finite(entry?.utilization);
    if (utilization === undefined) continue;
    const made = window(id, utilization, isoFromString(entry?.resets_at));
    if (made) windows.push(made);
  }
  // Model-specific caps the CLI lists by display name.
  const scoped = Array.isArray(usage.model_scoped) ? usage.model_scoped : [];
  for (const raw of scoped) {
    const entry = record(raw);
    const name = typeof entry?.display_name === 'string' ? entry.display_name : undefined;
    const utilization = finite(entry?.utilization);
    if (!name || utilization === undefined) continue;
    const id = `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    if (windows.some(existing => existing.id === id)) continue;
    const resetsAt = isoFromString(entry?.resets_at);
    windows.push({
      id,
      kind: 'model',
      label: name,
      usedPercent: clampPercent(utilization),
      windowDurationMins: WEEK_MINS,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const spend = claudeSpendPercent(usage);
  if (spend !== undefined) windows.push({ id: 'monthly_spend', kind: 'spend', usedPercent: spend });
  return windows.length > 0
    ? { checkedAt, windows, source: 'probe' }
    : { checkedAt, windows, source: 'probe', unavailable: { reason: 'unsupported' } };
}

function percentFromAmounts(used: unknown, limit: unknown): number | undefined {
  const spent = finite(used);
  const allowance = finite(limit);
  if (spent === undefined || allowance === undefined || spent < 0 || allowance <= 0) return undefined;
  return clampPercent((spent / allowance) * 100);
}

/** `{ amount_minor, currency, exponent }`, or `undefined` when it is not money. */
function money(value: unknown): { amount: number; currency: string; exponent: number } | undefined {
  const entry = record(value);
  const amount = finite(entry?.amount_minor);
  const exponent = finite(entry?.exponent);
  const currency = typeof entry?.currency === 'string' ? entry.currency.trim() : '';
  if (amount === undefined || amount < 0 || exponent === undefined || exponent < 0 || !currency) return undefined;
  return { amount, currency, exponent };
}

/**
 * How much of the paid budget on top of the plan is spent, 0–100: the `spend` budget when it is on
 * and its two amounts share a currency and scale (its own `percent` is rounded), else enabled
 * `extra_usage` by its credits or its utilization. `undefined` when neither is on.
 */
export function claudeSpendPercent(usage: Record<string, unknown>): number | undefined {
  const spend = record(usage.spend);
  if (spend?.enabled === true) {
    const used = money(spend.used);
    const limit = money(spend.limit);
    if (used && limit && used.currency === limit.currency && used.exponent === limit.exponent) {
      const percent = percentFromAmounts(used.amount, limit.amount);
      if (percent !== undefined) return percent;
    }
  }
  const extra = record(usage.extra_usage);
  if (extra?.is_enabled !== true) return undefined;
  const percent = percentFromAmounts(extra.used_credits, extra.monthly_limit) ?? finite(extra.utilization);
  return percent !== undefined && percent >= 0 ? clampPercent(percent) : undefined;
}
