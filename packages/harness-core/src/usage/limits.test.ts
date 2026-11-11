import { describe, expect, it } from 'vitest';

import type { UsageWindow } from './contracts.ts';
import { mergeUsageWindows, normalizeUsedPercent, reconcileUsageWindow, reconcileUsageWindows } from './contracts.ts';
import {
  effectiveUsedPercent,
  orderUsageWindows,
  tightestUsageWindow,
  usageResetsInMs,
  usageWindowElapsedShare,
  usageWindowPace,
} from './limits.ts';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

const session: UsageWindow = { id: 'five_hour', kind: 'session', usedPercent: 40, windowDurationMins: 300, resetsAt: inHours(2) };
const weekly: UsageWindow = { id: 'seven_day', kind: 'weekly', usedPercent: 82, windowDurationMins: 10_080, resetsAt: inHours(48) };
const opus: UsageWindow = { id: 'seven_day_opus', kind: 'model', label: 'Opus', usedPercent: 12, windowDurationMins: 10_080 };
const spend: UsageWindow = { id: 'monthly_spend', kind: 'spend', usedPercent: 9 };

describe('normalizeUsedPercent', () => {
  it('scales a 0–1 fraction and keeps a 0–100 percentage', () => {
    expect(normalizeUsedPercent(0.85, 'fraction')).toEqual({ usedPercent: 85, suspectedUnitChange: false });
    expect(normalizeUsedPercent(54, 'percent')).toEqual({ usedPercent: 54, suspectedUnitChange: false });
  });

  it('reads an overrun fraction as a used-up window', () => {
    expect(normalizeUsedPercent(1.02, 'fraction')).toEqual({ usedPercent: 100, suspectedUnitChange: false });
  });

  it('takes a "fraction" well past 1 as a percentage already and flags it', () => {
    expect(normalizeUsedPercent(54, 'fraction')).toEqual({ usedPercent: 54, suspectedUnitChange: true });
  });

  it('clamps out-of-range and non-finite values', () => {
    expect(normalizeUsedPercent(250, 'percent').usedPercent).toBe(100);
    expect(normalizeUsedPercent(-3, 'percent').usedPercent).toBe(0);
    expect(normalizeUsedPercent(Number.NaN, 'fraction').usedPercent).toBe(0);
  });
});

describe('reconcileUsageWindow', () => {
  it('scales back a fraction a 0–100 source sent inside the same period', () => {
    const told: UsageWindow = { ...weekly, usedPercent: 0.83, resetsAt: inHours(48.2) };
    expect(reconcileUsageWindow(weekly, told)).toEqual({ window: { ...told, usedPercent: 83 }, suspectedUnitChange: true });
  });

  it('believes a fall after a reset (a new period) or without reset times', () => {
    expect(reconcileUsageWindow(weekly, { ...weekly, usedPercent: 0.5, resetsAt: inHours(48 + 168) }).suspectedUnitChange).toBe(false);
    const noReset = { ...weekly, resetsAt: undefined };
    expect(reconcileUsageWindow(noReset, { ...noReset, usedPercent: 0.83 }).suspectedUnitChange).toBe(false);
  });

  it('believes a small reading that does not match the known one', () => {
    expect(reconcileUsageWindow(weekly, { ...weekly, usedPercent: 0.4 }).window.usedPercent).toBe(0.4);
    expect(reconcileUsageWindow({ ...weekly, usedPercent: 3 }, { ...weekly, usedPercent: 0.03 }).window.usedPercent).toBe(0.03);
  });

  it('names every window it put right', () => {
    const { windows, suspectedUnitChange } = reconcileUsageWindows([session, weekly], [{ ...session, usedPercent: 0.41 }, { ...weekly, usedPercent: 84 }]);
    expect(windows.map(window => window.usedPercent)).toEqual([41, 84]);
    expect(suspectedUnitChange).toEqual(['five_hour']);
  });
});

describe('mergeUsageWindows', () => {
  it('keeps the known reset time and length a partial update leaves out', () => {
    const merged = mergeUsageWindows([session], [{ id: 'five_hour', kind: 'session', usedPercent: 45 }]);
    expect(merged).toEqual([{ ...session, usedPercent: 45 }]);
  });

  it('guards the unit of the windows it folds in', () => {
    const merged = mergeUsageWindows([session, weekly], [{ ...weekly, usedPercent: 0.85 }]);
    expect(merged.find(window => window.id === 'seven_day')?.usedPercent).toBe(85);
  });
});

describe('reading windows', () => {
  it('orders session, week, models, month and spend', () => {
    expect(orderUsageWindows([spend, opus, weekly, session]).map(window => window.id)).toEqual([
      'five_hour',
      'seven_day',
      'seven_day_opus',
      'monthly_spend',
    ]);
  });

  it('picks the window closest to its limit, the earlier on a tie', () => {
    expect(tightestUsageWindow([session, weekly, opus], now)?.id).toBe('seven_day');
    expect(tightestUsageWindow([{ ...weekly, usedPercent: 40 }, session], now)?.id).toBe('five_hour');
    expect(tightestUsageWindow([], now)).toBeUndefined();
  });

  it('reads a window whose reset has passed as empty', () => {
    const past = { ...weekly, usedPercent: 100, resetsAt: inHours(-1) };
    expect(effectiveUsedPercent(past, now)).toBe(0);
    expect(tightestUsageWindow([past, session], now)?.id).toBe('five_hour');
    expect(usageResetsInMs(past, now)).toBe(0);
    expect(usageResetsInMs(opus, now)).toBeNull();
  });

  it('measures pace against the time the window has run', () => {
    // 3 of 5 hours have run (60 %): 40 % used is under pace, 80 % ahead, 62 % on it.
    expect(usageWindowElapsedShare(session, now)).toBeCloseTo(0.6);
    expect(usageWindowPace(session, now)).toBe('under');
    expect(usageWindowPace({ ...session, usedPercent: 80 }, now)).toBe('ahead');
    expect(usageWindowPace({ ...session, usedPercent: 62 }, now)).toBe('on');
    expect(usageWindowPace(opus, now)).toBeNull();
  });
});
