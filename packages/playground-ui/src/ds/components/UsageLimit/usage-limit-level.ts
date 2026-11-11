/** From here a limit reads as getting close (amber). */
export const USAGE_LIMIT_WARNING_PERCENT = 80;
/** From here a limit reads as about to run out (red). */
export const USAGE_LIMIT_CRITICAL_PERCENT = 95;

/** How close a used share is to its limit: fine, getting close, about to run out (or out). */
export type UsageLimitLevel = 'ok' | 'warning' | 'critical';

export function usageLimitLevel(percent: number): UsageLimitLevel {
  if (percent >= USAGE_LIMIT_CRITICAL_PERCENT) return 'critical';
  if (percent >= USAGE_LIMIT_WARNING_PERCENT) return 'warning';
  return 'ok';
}

/** The fill of a bar or ring at each level. */
export const usageLimitFill: Readonly<Record<UsageLimitLevel, string>> = {
  ok: 'bg-foreground',
  warning: 'bg-warning-indicator',
  critical: 'bg-destructive-indicator',
};

/** The ink of a ring's arc and of the reading beside it at each level. */
export const usageLimitInk: Readonly<Record<UsageLimitLevel, string>> = {
  ok: 'text-foreground',
  warning: 'text-warning-foreground',
  critical: 'text-destructive-foreground',
};
