// Codex's allowance as usage windows: the session (5 hours), weekly and monthly limits its
// rate-limit snapshots report, and when an exhausted allowance resets (a usage-limit error's
// `resetsAt`, as a Claude Code limit carries one).
import type { RateLimitSnapshot } from './protocol/schema.ts';

export interface CodexUsageWindow {
  readonly id: string;
  readonly kind: 'session' | 'weekly' | 'monthly';
  readonly label: string;
  readonly usedPercent: number;
  readonly windowDurationMins?: number;
  readonly resetsAt?: string;
}

export interface CodexResetCreditsSummary {
  readonly availableCount: number;
  readonly credits?: ReadonlyArray<{ readonly status: string; readonly expiresAt?: number | null }> | null;
}

export interface CodexUsageLimits {
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<CodexUsageWindow>;
  readonly resetCredits?: { readonly availableCount: number; readonly nextExpiresAt?: string };
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function kindForDuration(mins: number): CodexUsageWindow['kind'] {
  if (mins >= MONTH_MINS) return 'monthly';
  if (mins >= WEEK_MINS) return 'weekly';
  return 'session';
}

function labelForKind(kind: CodexUsageWindow['kind']): string {
  return kind === 'session' ? 'Session' : kind === 'weekly' ? 'Weekly' : 'Monthly';
}

/** primary/secondary are positions; without windowDurationMins, paid plans use 5-hour/weekly windows and Free/Go use monthly. */
export function codexRateLimitsToWindows(snapshot: RateLimitSnapshot): ReadonlyArray<CodexUsageWindow> {
  // Keep model-specific limits out of main allowance rows; older CLIs omit limit IDs.
  if (snapshot.limitId && snapshot.limitId !== 'codex') return [];
  const isMonthlyPlan = snapshot.planType === 'free' || snapshot.planType === 'go';
  const positions = [
    ['primary', snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ['secondary', snapshot.secondary, WEEK_MINS],
  ] as const;
  const windows: CodexUsageWindow[] = [];
  for (const [id, window, fallbackMins] of positions) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const windowDurationMins = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : fallbackMins;
    const kind = kindForDuration(windowDurationMins);
    const resetsAt = isoFromEpochSeconds(window.resetsAt);
    windows.push({
      id,
      kind,
      label: labelForKind(kind),
      usedPercent: clampPercent(window.usedPercent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const individualLimit = snapshot.individualLimit;
  if (individualLimit && Number.isFinite(individualLimit.remainingPercent)) {
    const resetsAt = isoFromEpochSeconds(individualLimit.resetsAt);
    windows.push({
      id: 'individual',
      kind: 'monthly',
      label: 'Monthly credit limit',
      usedPercent: clampPercent(100 - individualLimit.remainingPercent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

function codexResetCredits(summary: CodexResetCreditsSummary | null | undefined): CodexUsageLimits['resetCredits'] {
  if (!summary) return undefined;
  const expiries = (summary.credits ?? [])
    .filter(credit => credit.status === 'available')
    .map(credit => credit.expiresAt)
    .filter((value): value is number => typeof value === 'number');
  const nextExpiresAt = expiries.length > 0 ? isoFromEpochSeconds(Math.min(...expiries)) : undefined;
  return { availableCount: Math.max(0, summary.availableCount), ...(nextExpiresAt ? { nextExpiresAt } : {}) };
}

export function codexRateLimitsToLimits(input: {
  readonly snapshot: RateLimitSnapshot;
  readonly rateLimitsByLimitId?: Readonly<Record<string, RateLimitSnapshot>> | null;
  readonly resetCredits?: CodexResetCreditsSummary | null;
  readonly checkedAt: string;
}): CodexUsageLimits {
  const resetCredits = codexResetCredits(input.resetCredits);
  return {
    checkedAt: input.checkedAt,
    windows: codexRateLimitsToWindows(input.rateLimitsByLimitId?.codex ?? input.snapshot),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

/** Rate-limit notifications are partial: omitted fields preserve earlier session values. */
export function mergeCodexRateLimits(
  previous: RateLimitSnapshot | undefined,
  update: RateLimitSnapshot,
): RateLimitSnapshot | undefined {
  // Model-specific snapshots must not overwrite the main allowance.
  if (update.limitId && update.limitId !== 'codex') return previous;
  if (!previous) return update;
  return {
    ...previous,
    ...(update.limitId !== undefined ? { limitId: update.limitId } : {}),
    ...(update.planType !== undefined ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType !== undefined ? { rateLimitReachedType: update.rateLimitReachedType } : {}),
    ...(update.primary !== undefined ? { primary: update.primary } : {}),
    ...(update.secondary !== undefined ? { secondary: update.secondary } : {}),
    ...(update.individualLimit !== undefined ? { individualLimit: update.individualLimit } : {}),
  };
}

/** All exhausted windows must reset before a continuation can run. */
export function codexUsageLimitResetAt(snapshot: RateLimitSnapshot | undefined): string | null {
  if (!snapshot) return null;
  const windows = codexRateLimitsToWindows(snapshot).filter(window => window.usedPercent >= 100);
  if (windows.length === 0 || windows.some(window => !window.resetsAt)) return null;
  return windows.reduce<string | null>(
    (latest, window) => (latest === null || Date.parse(window.resetsAt!) > Date.parse(latest) ? window.resetsAt! : latest),
    null,
  );
}
