// Reading an account's allowance windows the same way wherever they show: which window is tightest,
// what a window reads once its reset has passed, and whether spending runs ahead of the clock.
// Browser-safe; every harness's windows go through these alike.
import type { UsageWindow, UsageWindowKind } from './contracts.ts';

const MINUTE_MS = 60_000;

/** Reading order: the 5-hour session, the week, the models' weekly caps, the month, paid budgets. */
const KIND_ORDER: Readonly<Record<UsageWindowKind, number>> = { session: 0, weekly: 1, model: 2, monthly: 3, spend: 4 };

/** Windows in reading order; ties by label, then id, so a list never reshuffles between readings. */
export function orderUsageWindows(windows: ReadonlyArray<UsageWindow>): UsageWindow[] {
  return [...windows].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.label ?? a.id).localeCompare(b.label ?? b.id),
  );
}

function resetMs(window: UsageWindow): number | null {
  if (!window.resetsAt) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** True once the window's reset time has passed: what was read belongs to the previous period. */
export function hasUsageWindowReset(window: UsageWindow, now: number): boolean {
  const at = resetMs(window);
  return at !== null && at <= now;
}

/** The share used as of `now`: a window whose reset has passed starts again from nothing. */
export function effectiveUsedPercent(window: UsageWindow, now: number): number {
  return hasUsageWindowReset(window, now) ? 0 : window.usedPercent;
}

/** Milliseconds until the window resets; `null` when the provider gave no reset time. */
export function usageResetsInMs(window: UsageWindow, now: number): number | null {
  const at = resetMs(window);
  return at === null ? null : Math.max(0, at - now);
}

/**
 * The window closest to its limit now, the one a person has to watch. Ties go to the earlier window
 * in reading order (the 5-hour session before the week). `undefined` without windows.
 */
export function tightestUsageWindow(windows: ReadonlyArray<UsageWindow>, now: number): UsageWindow | undefined {
  let tightest: UsageWindow | undefined;
  for (const window of orderUsageWindows(windows)) {
    if (!tightest || effectiveUsedPercent(window, now) > effectiveUsedPercent(tightest, now)) tightest = window;
  }
  return tightest;
}

/** How much of the window's time has passed, 0–1; `null` without a reset time and length. */
export function usageWindowElapsedShare(window: UsageWindow, now: number): number | null {
  const at = resetMs(window);
  if (at === null || window.windowDurationMins === undefined || window.windowDurationMins <= 0) return null;
  const length = window.windowDurationMins * MINUTE_MS;
  return Math.max(0, Math.min(1, (length - (at - now)) / length));
}

/** Spending against the clock: `ahead` uses the allowance faster than the window elapses. */
export type UsagePace = 'ahead' | 'on' | 'under';

/** How far usage may run from even spending before it counts as ahead or under, in points. */
const PACE_SLACK_PERCENT = 5;

export function usageWindowPace(window: UsageWindow, now: number): UsagePace | null {
  if (hasUsageWindowReset(window, now)) return null;
  const elapsed = usageWindowElapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > PACE_SLACK_PERCENT) return 'ahead';
  if (gap < -PACE_SLACK_PERCENT) return 'under';
  return 'on';
}
