import { currentLanguage } from '../../i18n';

const DAY_MS = 86_400_000;

// all inside the server's 366-day aggregation cap (metrics and usage alike)
export const RANGE_PRESETS = [7, 30, 90, 365] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const DEFAULT_RANGE_DAYS: RangePreset = 30;

export function isRangePreset(value: unknown): value is RangePreset {
  return RANGE_PRESETS.includes(Number(value) as RangePreset) && String(Number(value)) === String(value);
}

function shiftUtcDay(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

/** The window's inclusive UTC days, ending today: what both the metrics and the usage routes read. */
export function rangeWindow(days: number, now = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  return { from: shiftUtcDay(to, -(days - 1)), to };
}

/** A UTC day as the chart's x-axis prints it. */
export function dayLabel(day: string): string {
  return new Intl.DateTimeFormat(currentLanguage(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

/** A per-day average, as the KPI cards print it. */
export function formatPerDay(value: number): string {
  return value.toLocaleString(currentLanguage(), { maximumFractionDigits: 1 });
}
