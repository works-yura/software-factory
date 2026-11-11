import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { cn } from '@mastra/playground-ui/utils/cn';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { formatDuration } from '../../../../lib/date';
import { translator } from '../../../i18n/t';
import { AnalyticsEmptyPreview } from '../../analytics/components/AnalyticsEmptyPreview';
import type { AgeBucket, QueueHealth, QueueHealthStage } from '../queue-health';
import { AGE_BUCKETS } from '../queue-health';

const tk = translator('analytics');

const FOCUS = 'focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-border-focus';

// order matches AGE_BUCKETS
const BUCKET_COLOR: Record<AgeBucket, string> = {
  green: 'bg-queue-fresh',
  amber: 'bg-queue-aging',
  orange: 'bg-queue-stale',
  red: 'bg-queue-critical',
};

export function bucketLabel(bucket: AgeBucket): string {
  return tk(`queue.buckets.${bucket}`);
}

export interface QueueHealthSelection {
  /** Lane key; `null` selects the cohort across every stage. */
  stage: string | null;
  bucket: AgeBucket;
}

/** `anchor` is the clicked cell, so the drill-down can open on it. */
export type QueueHealthSelect = (selection: QueueHealthSelection | null, anchor?: HTMLElement) => void;

export interface QueueHealthChartProps {
  health: QueueHealth;
  thresholdsSeconds: number[];
  selected: QueueHealthSelection | null;
  onSelect: QueueHealthSelect;
  /** Shown beside the empty state, e.g. a link to the board. */
  emptyAction?: ReactNode;
}

function boundLabel(seconds: number): string {
  if (seconds < 3600) return tk('queue.units.m', { value: Math.round(seconds / 60) });
  if (seconds < 86400) return tk('queue.units.h', { value: Math.round(seconds / 3600) });
  return tk('queue.units.d', { value: Math.round(seconds / 86400) });
}

function bucketRangeLabel(bucket: AgeBucket, thresholds: number[]): string {
  const index = AGE_BUCKETS.indexOf(bucket);
  const lower = index === 0 ? 0 : thresholds[index - 1]!;
  const upper = thresholds[index];
  if (index === 0) return `< ${boundLabel(upper!)}`;
  if (upper === undefined) return `≥ ${boundLabel(lower)}`;
  return `${boundLabel(lower)}–${boundLabel(upper)}`;
}

function taskCount(count: number): string {
  return tk('queue.tasks', { count });
}

function sameSelection(a: QueueHealthSelection | null, stage: string | null, bucket: AgeBucket): boolean {
  return a !== null && a.bucket === bucket && a.stage === stage;
}

export function QueueHealthChart({ health, thresholdsSeconds, selected, onSelect, emptyAction }: QueueHealthChartProps) {
  const [hovered, setHovered] = useState<AgeBucket | null>(null);

  const totals = useMemo(() => {
    const buckets: Record<AgeBucket, number> = { green: 0, amber: 0, orange: 0, red: 0 };
    let total = 0;
    for (const stage of health.stages) {
      for (const bucket of AGE_BUCKETS) buckets[bucket] += stage.buckets[bucket];
      total += stage.total;
    }
    return { buckets, total };
  }, [health.stages]);

  if (totals.total === 0) {
    return (
      <AnalyticsEmptyPreview
        kind="share"
        title={tk('queue.empty')}
        description={tk('queue.emptyDescription')}
        action={emptyAction}
      />
    );
  }

  const focused = hovered ?? selected?.bucket ?? null;
  const fade = (bucket: AgeBucket) => (focused !== null && focused !== bucket ? 'opacity-25' : 'opacity-100');

  return (
    <div
      className="flex flex-col gap-5"
      onKeyDown={event => {
        if (event.key === 'Escape') onSelect(null);
      }}
    >
      <div className="flex h-10 gap-1" onMouseLeave={() => setHovered(null)}>
        {AGE_BUCKETS.map(bucket => {
          const count = totals.buckets[bucket];
          if (count === 0) return null;
          return (
            <Segment
              key={bucket}
              bucket={bucket}
              count={count}
              stage={null}
              thresholdsSeconds={thresholdsSeconds}
              selected={selected}
              fade={fade(bucket)}
              onHover={setHovered}
              onSelect={onSelect}
              className="rounded-lg hover:-translate-y-0.5"
            />
          );
        })}
      </div>

      <Legend
        totals={totals}
        thresholdsSeconds={thresholdsSeconds}
        selected={selected}
        focused={focused}
        onHover={setHovered}
        onSelect={onSelect}
      />

      <ul className="m-0 flex list-none flex-col border-t border-border p-0 pt-3">
        {health.stages.map(stage => (
          <StageRow
            key={stage.key}
            stage={stage}
            thresholdsSeconds={thresholdsSeconds}
            selected={selected}
            fade={fade}
            onHover={setHovered}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function Segment({
  bucket,
  count,
  stage,
  thresholdsSeconds,
  selected,
  fade,
  onHover,
  onSelect,
  className,
}: {
  bucket: AgeBucket;
  count: number;
  stage: QueueHealthStage | null;
  thresholdsSeconds: number[];
  selected: QueueHealthSelection | null;
  fade: string;
  onHover: (bucket: AgeBucket | null) => void;
  onSelect: QueueHealthSelect;
  className: string;
}) {
  const key = stage?.key ?? null;
  const isSelected = sameSelection(selected, key, bucket);
  const name = stage === null ? `${bucketLabel(bucket)}: ${count}` : `${stage.label} ${bucketLabel(bucket)}: ${count}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={isSelected}
            aria-label={name}
            style={{ flexGrow: count }}
            onMouseEnter={() => onHover(bucket)}
            onFocus={() => onHover(bucket)}
            onBlur={() => onHover(null)}
            onClick={event => onSelect(isSelected ? null : { stage: key, bucket }, event.currentTarget)}
            className={cn(
              'h-full min-w-1 basis-0 cursor-pointer transition-all duration-200 focus-visible:outline-offset-2 motion-reduce:transition-none',
              FOCUS,
              BUCKET_COLOR[bucket],
              fade,
              isSelected && 'outline-2 outline-offset-2 outline-foreground',
              className,
            )}
          />
        }
      />
      <TooltipContent>
        {stage === null ? '' : `${stage.label} · `}
        {bucketLabel(bucket)} · {taskCount(count)} · {bucketRangeLabel(bucket, thresholdsSeconds)}
      </TooltipContent>
    </Tooltip>
  );
}

function Legend({
  totals,
  thresholdsSeconds,
  selected,
  focused,
  onHover,
  onSelect,
}: {
  totals: { buckets: Record<AgeBucket, number>; total: number };
  thresholdsSeconds: number[];
  selected: QueueHealthSelection | null;
  focused: AgeBucket | null;
  onHover: (bucket: AgeBucket | null) => void;
  onSelect: QueueHealthSelect;
}) {
  return (
    <ul data-testid="queue-health-legend" className="m-0 grid list-none grid-cols-1 gap-x-4 gap-y-0.5 p-0 sm:grid-cols-2">
      {AGE_BUCKETS.map(bucket => {
        const count = totals.buckets[bucket];
        const isSelected = sameSelection(selected, null, bucket);
        const share = Math.round((count / totals.total) * 100);
        return (
          <li key={bucket}>
            <button
              type="button"
              disabled={count === 0}
              aria-pressed={isSelected}
              onMouseEnter={() => onHover(bucket)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(bucket)}
              onBlur={() => onHover(null)}
              onClick={event => onSelect(isSelected ? null : { stage: null, bucket }, event.currentTarget)}
              className={cn(
                'group flex w-full cursor-pointer items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-fill-subtle aria-pressed:bg-fill-subtle disabled:pointer-events-none disabled:opacity-40',
                FOCUS,
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-7 w-[3px] shrink-0 rounded-full transition-opacity duration-200',
                  BUCKET_COLOR[bucket],
                  focused !== null && focused !== bucket ? 'opacity-25' : 'opacity-100',
                )}
              />
              <span className="flex min-w-0 flex-col">
                <Txt as="span" variant="meta" tone="muted" className="truncate">
                  {bucketLabel(bucket)} ({bucketRangeLabel(bucket, thresholdsSeconds)})
                </Txt>
                <Txt as="span" variant="label" tone="ink" className="tabular-nums">
                  {count}
                </Txt>
              </span>
              <span className="ml-auto shrink-0 rounded-full bg-fill-subtle px-2 py-0.5 text-meta text-muted-foreground tabular-nums transition-colors group-hover:bg-fill-hover">
                {share}%
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function StageRow({
  stage,
  thresholdsSeconds,
  selected,
  fade,
  onHover,
  onSelect,
}: {
  stage: QueueHealthStage;
  thresholdsSeconds: number[];
  selected: QueueHealthSelection | null;
  fade: (bucket: AgeBucket) => string;
  onHover: (bucket: AgeBucket | null) => void;
  onSelect: QueueHealthSelect;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-fill-subtle">
      <Txt as="span" variant="body-sm" tone="muted" className="truncate">
        {stage.label}
      </Txt>

      {stage.total === 0 ? (
        <div className="h-2 rounded-full bg-fill-subtle opacity-50" aria-hidden="true" />
      ) : (
        <div className="flex h-2 gap-0.5" onMouseLeave={() => onHover(null)}>
          {AGE_BUCKETS.map(bucket => {
            const count = stage.buckets[bucket];
            if (count === 0) return null;
            return (
              <Segment
                key={bucket}
                bucket={bucket}
                count={count}
                stage={stage}
                thresholdsSeconds={thresholdsSeconds}
                selected={selected}
                fade={fade(bucket)}
                onHover={onHover}
                onSelect={onSelect}
                className="rounded-full hover:scale-y-150"
              />
            );
          })}
        </div>
      )}

      <span className="flex items-center justify-end gap-2">
        {stage.activeCount > 0 ? <ActivePulse label={stage.label} activeCount={stage.activeCount} /> : null}
        <Txt as="span" variant="meta" tone="muted" className="w-6 text-right tabular-nums">
          {stage.total}
        </Txt>
      </span>
    </li>
  );
}

function ActivePulse({ label, activeCount }: { label: string; activeCount: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={tk('queue.active', { stage: label, count: activeCount })}
            className={cn('inline-flex items-center gap-1.5 rounded-full bg-fill-subtle px-1.5 py-0.5', FOCUS)}
          >
            <span className="relative flex size-1.5" aria-hidden="true">
              <span className="absolute inline-flex size-full rounded-full bg-brand-green opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex size-1.5 rounded-full bg-brand-green" />
            </span>
            <span className="text-meta text-muted-foreground tabular-nums">{activeCount}</span>
          </span>
        }
      />
      <TooltipContent>{tk('queue.agents', { count: activeCount })}</TooltipContent>
    </Tooltip>
  );
}

export function formatAgeSeconds(ageSeconds: number): string {
  return ageSeconds < 60 ? tk('queue.justNow') : formatDuration(ageSeconds * 1000);
}
