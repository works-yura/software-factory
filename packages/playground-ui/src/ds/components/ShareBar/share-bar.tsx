import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ds/components/Tooltip';
import { Txt } from '@/ds/components/Txt';
import { focusRing } from '@/ds/primitives/transitions';
import { libText } from '@/lib/lib-text';
import { cn } from '@/lib/utils';

export interface ShareBarSlice {
  key: string;
  label: string;
  value: number;
  /** Background utility, e.g. `bg-chart-sequential-5`. */
  color: string;
  /** A second reading under the value in the legend, e.g. a cost beside tokens. */
  detail?: string;
}

export type ShareBarProps = {
  slices: ShareBarSlice[];
  /** The value as the legend prints it. Defaults to the plain number. */
  formatValue?: (value: number) => string;
  /** The value as the tooltip and screen readers say it, e.g. "3 items". Defaults to `formatValue`. */
  formatAmount?: (value: number) => string;
  /**
   * Slices beyond this many fold into one "Other" slice, so a long tail stays one readable segment.
   * The legend can still be opened up to list every slice.
   */
  limit?: number;
  /** The folded slice's label. */
  otherLabel?: string;
};

const OTHER_KEY = '\u0000other';
const OTHER_COLOR = 'bg-chart-share-rest';

/** The first `limit` slices, then the rest summed into one; slices are kept in the order given. */
export function foldShareBarSlices(slices: ShareBarSlice[], limit: number, otherLabel: string): ShareBarSlice[] {
  if (slices.length <= limit) return slices;
  const rest = slices.slice(limit);
  return [
    ...slices.slice(0, limit),
    { key: OTHER_KEY, label: otherLabel, value: rest.reduce((sum, slice) => sum + slice.value, 0), color: OTHER_COLOR },
  ];
}

/**
 * Parts of one whole as a chunky segmented bar, with a legend tile per part giving its value and
 * share. Hovering a segment or a tile dims the others.
 */
export function ShareBar({
  slices,
  formatValue = value => String(value),
  formatAmount = formatValue,
  limit = Number.POSITIVE_INFINITY,
  otherLabel = libText('Other'),
}: ShareBarProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) return null;

  const folded = foldShareBarSlices(slices, limit, otherLabel);
  const legend = showAll ? slices : folded;
  const foldedCount = slices.length - limit;

  const fade = (key: string) => (hovered !== null && hovered !== key ? 'opacity-25' : 'opacity-100');
  const share = (value: number) => Math.round((value / total) * 100);

  return (
    <div data-slot="share-bar" className="flex flex-col gap-4">
      <div className="flex h-10 gap-1" onMouseLeave={() => setHovered(null)}>
        {folded.map(slice =>
          slice.value === 0 ? null : (
            <Tooltip key={slice.key}>
              <TooltipTrigger
                render={
                  <div
                    role="img"
                    tabIndex={0}
                    aria-label={`${slice.label}: ${formatAmount(slice.value)}, ${share(slice.value)}%`}
                    style={{ flexGrow: slice.value }}
                    onMouseEnter={() => setHovered(slice.key)}
                    onFocus={() => setHovered(slice.key)}
                    onBlur={() => setHovered(null)}
                    className={cn(
                      'h-full min-w-1 basis-0 rounded-lg transition-all duration-200 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0',
                      focusRing,
                      'focus-visible:outline-offset-2',
                      slice.color,
                      fade(slice.key),
                    )}
                  />
                }
              />
              <TooltipContent>
                {slice.label} · {formatAmount(slice.value)} · {share(slice.value)}%
              </TooltipContent>
            </Tooltip>
          ),
        )}
      </div>

      <ul className="m-0 grid list-none grid-cols-1 gap-x-4 gap-y-0.5 p-0 sm:grid-cols-2">
        {legend.map(slice => {
          // The legend opened up lists the tail one by one; their bar segment is the folded one.
          const segment = folded.some(candidate => candidate.key === slice.key) ? slice.key : OTHER_KEY;
          return (
            <li
              key={slice.key}
              onMouseEnter={() => setHovered(segment)}
              onMouseLeave={() => setHovered(null)}
              className="group flex items-center gap-2.5 rounded-lg p-2 transition-colors hover:bg-fill-subtle"
            >
              <span
                aria-hidden="true"
                className={cn('h-7 w-[3px] shrink-0 rounded-full transition-opacity duration-200', slice.color, fade(segment))}
              />
              <span className="flex min-w-0 flex-col">
                <Txt as="span" variant="meta" tone="muted" className="truncate">
                  {slice.label}
                </Txt>
                <span className="flex min-w-0 items-baseline gap-2">
                  <Txt as="span" variant="label" tone="ink" className="tabular-nums">
                    {formatValue(slice.value)}
                  </Txt>
                  {slice.detail ? (
                    <Txt as="span" variant="meta" tone="muted" className="truncate tabular-nums">
                      {slice.detail}
                    </Txt>
                  ) : null}
                </span>
              </span>
              <span className="ml-auto shrink-0 rounded-full bg-fill-subtle px-2 py-0.5 text-meta text-muted-foreground tabular-nums transition-colors group-hover:bg-fill-hover">
                {share(slice.value)}%
              </span>
            </li>
          );
        })}
      </ul>

      {foldedCount > 0 ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(open => !open)}
          className={cn(
            'w-fit cursor-pointer rounded-md px-2 py-1 text-meta text-muted-foreground transition-colors hover:bg-fill-subtle hover:text-foreground',
            focusRing,
          )}
        >
          {showAll ? libText('Show less') : libText('Show {count} more').replace('{count}', String(foldedCount))}
        </button>
      ) : null}
    </div>
  );
}
