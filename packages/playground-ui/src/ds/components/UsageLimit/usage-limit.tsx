import type { ReactNode } from 'react';
import { usageLimitFill, usageLimitInk, usageLimitLevel } from './usage-limit-level';
import { Txt } from '@/ds/components/Txt';
import { cn } from '@/lib/utils';

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const clamp = (percent: number) => (Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0);

interface MeterReading {
  /** 0–100: how much of the limit is used. */
  percent: number;
  /** What the limit is, spoken before its value (`5-hour`). */
  label: string;
  /** The value as spoken; defaults to `NN%`. */
  valueText?: string;
}

function meterProps({ percent, label, valueText }: MeterReading) {
  const value = Math.round(clamp(percent));
  return {
    role: 'meter',
    'aria-label': label,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuenow': value,
    'aria-valuetext': valueText ?? `${value}%`,
    'data-level': usageLimitLevel(value),
  } as const;
}

export interface UsageLimitBarProps extends MeterReading {
  className?: string;
}

/** A limit as a thin bar: amber from 80 % used, red from 95 %. */
export function UsageLimitBar({ className, ...reading }: UsageLimitBarProps) {
  const props = meterProps(reading);
  const width = clamp(reading.percent);
  return (
    <span
      {...props}
      data-slot="usage-limit-bar"
      className={cn('relative block h-1.5 w-full min-w-0 overflow-hidden rounded-full bg-fill-strong', className)}
    >
      {width > 0 ? (
        <span
          aria-hidden
          className={cn('absolute inset-y-0 left-0 rounded-full', usageLimitFill[props['data-level']])}
          style={{ width: `${width}%` }}
        />
      ) : null}
    </span>
  );
}

export interface UsageLimitRingProps extends MeterReading {
  /** Printed beside the ring (the percentage, a reset countdown); nothing when absent. */
  children?: ReactNode;
  className?: string;
}

/** A limit as a small ring with its reading beside it, for a status line. */
export function UsageLimitRing({ className, children, ...reading }: UsageLimitRingProps) {
  const props = meterProps(reading);
  const fill = clamp(reading.percent);
  const wedge = `${((CIRCUMFERENCE * fill) / 100).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`;
  return (
    <span
      {...props}
      data-slot="usage-limit-ring"
      className={cn('inline-flex items-center gap-1.5 tabular-nums', usageLimitInk[props['data-level']], className)}
    >
      <svg aria-hidden viewBox="0 0 20 20" className="block size-3.5 flex-none -rotate-90">
        <circle cx="10" cy="10" r={RADIUS} strokeWidth="3" fill="none" style={{ stroke: 'var(--border-strong)' }} />
        {fill > 0 ? (
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            strokeWidth="3"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeDasharray={wedge}
          />
        ) : null}
      </svg>
      {children}
    </span>
  );
}

export interface UsageLimitRowProps extends MeterReading {
  /** The reading printed after the bar (`82%`). */
  value: ReactNode;
  /** A second line under the bar: when it resets, the pace. */
  detail?: ReactNode;
  className?: string;
}

/**
 * One limit of an account: its name, its bar and its reading in a row, with an optional line
 * beneath. Rows stacked in a container line up.
 */
export function UsageLimitRow({ value, detail, className, ...reading }: UsageLimitRowProps) {
  const level = usageLimitLevel(Math.round(clamp(reading.percent)));
  return (
    <div
      data-slot="usage-limit-row"
      className={cn('grid grid-cols-[minmax(5rem,7.5rem)_minmax(3rem,1fr)_auto] items-center gap-x-3 gap-y-0.5', className)}
    >
      <Txt as="span" variant="meta" tone="muted" className="truncate">
        {reading.label}
      </Txt>
      <UsageLimitBar {...reading} />
      <Txt as="span" variant="meta" className={cn('text-right tabular-nums', level === 'ok' ? 'text-muted-foreground' : usageLimitInk[level])}>
        {value}
      </Txt>
      {detail ? (
        <Txt as="span" variant="meta" tone="faint" className="col-start-2 col-end-4 tabular-nums">
          {detail}
        </Txt>
      ) : null}
    </div>
  );
}
