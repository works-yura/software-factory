import { ChevronDown } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Card } from '@/ds/components/Card';
import { Sparkline } from '@/ds/components/Sparkline';
import { Txt } from '@/ds/components/Txt';
import { focusRing } from '@/ds/primitives/transitions';
import { cn } from '@/lib/utils';

/**
 * Run a layout change as a View Transition, so whatever it moves glides into place (a card growing
 * into its chart, its neighbours reflowing). Without the API the change just lands.
 */
export function morphView(update: () => void) {
  const view = (typeof document === 'undefined' ? undefined : document) as
    | (Document & { startViewTransition?: (callback: () => void) => { ready: Promise<void> } })
    | undefined;
  if (typeof view?.startViewTransition !== 'function') {
    update();
    return;
  }
  // flushSync required — the transition captures the DOM synchronously after the callback.
  // A hidden tab or an overlapping transition rejects `ready`; the DOM update still lands.
  view.startViewTransition(() => flushSync(update)).ready.catch(() => {});
}

const LABEL = 'flex items-center gap-1.5 [&>svg]:size-3.5';
const SURFACE = 'flex min-w-0 flex-col p-4';

export type MetricsTrendCardProps = {
  icon: ReactNode;
  label: string;
  value: string;
  /** A short reading under the value, e.g. "0.4 per day". */
  detail?: string;
  /** The daily series the preview draws. */
  values: number[];
  /** Any CSS color for the preview, e.g. `var(--chart-green)`. */
  color: string;
  /** Nothing to plot yet: the preview is a dashed outline instead of a line. */
  empty?: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Accessible name of the card's toggle: the figure, and what opening it shows. */
  toggleLabel: string;
  /** Printed over the full chart. */
  chartCaption?: string;
  /** The full chart, rendered only while the card is open. */
  children: ReactNode;
  /** Grid placement while closed (open, the card spans the row). */
  className?: string;
};

/**
 * A KPI with a trend preview that grows in place into its full chart. The whole card is the toggle;
 * the change runs as a View Transition, so the card and its neighbours glide to their new places.
 * Meant for a `<dl>` grid: the label is the term, the reading and its chart the description.
 */
export function MetricsTrendCard({
  icon,
  label,
  value,
  detail,
  values,
  color,
  empty = false,
  expanded,
  onExpandedChange,
  toggleLabel,
  chartCaption,
  children,
  className,
}: MetricsTrendCardProps) {
  const chartId = useId();
  const transitionName = `metrics-trend-${chartId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <Card
      data-slot="metrics-trend-card"
      data-expanded={expanded || undefined}
      style={{ viewTransitionName: transitionName }}
      className={cn(SURFACE, 'group', expanded ? 'col-span-full' : className)}
    >
      <dt>
        <Txt as="span" variant="eyebrow" tone="muted" className={LABEL}>
          {icon}
          {label}
        </Txt>
      </dt>

      <dd className="m-0 mt-3 flex min-w-0 flex-col">
        <div className="relative flex items-center justify-between gap-4">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-display text-foreground tabular-nums">{value}</span>
            {detail ? (
              <Txt as="span" variant="meta" tone="muted" className="truncate">
                {detail}
              </Txt>
            ) : null}
          </span>

          <span className="flex shrink-0 items-center gap-3">
            {expanded ? null : (
              <Sparkline
                values={values}
                color={color}
                placeholder={empty}
                className="h-12 w-20 opacity-80 transition-opacity duration-200 group-hover:opacity-100 sm:w-28"
              />
            )}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-4 text-muted-foreground transition-transform duration-300 motion-reduce:transition-none',
                expanded && 'rotate-180',
              )}
            />
          </span>

          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? chartId : undefined}
            aria-label={toggleLabel}
            onClick={() => morphView(() => onExpandedChange(!expanded))}
            className={cn('absolute -inset-2 cursor-pointer rounded-lg', focusRing, 'focus-visible:outline-offset-2')}
          />
        </div>

        {expanded ? (
          <div
            id={chartId}
            className="mt-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300"
          >
            {chartCaption ? (
              <Txt as="p" variant="meta" tone="muted" className="m-0 mb-2">
                {chartCaption}
              </Txt>
            ) : null}
            {children}
          </div>
        ) : null}
      </dd>
    </Card>
  );
}

export type MetricsReadoutProps = {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  className?: string;
};

/** A KPI read at a glance, sized and labelled like `MetricsTrendCard` so the two share a row. */
export function MetricsReadout({ icon, label, value, detail, className }: MetricsReadoutProps) {
  return (
    <Card data-slot="metrics-readout" className={cn(SURFACE, 'gap-3', className)}>
      <dt>
        <Txt as="span" variant="eyebrow" tone="muted" className={LABEL}>
          {icon}
          {label}
        </Txt>
      </dt>
      <dd className="m-0 flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-display text-foreground tabular-nums">{value}</span>
        {detail ? (
          <Txt as="span" variant="meta" tone="muted" className="truncate">
            {detail}
          </Txt>
        ) : null}
      </dd>
    </Card>
  );
}
