import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Link } from 'react-router';

import { translator } from '../../../i18n/t';

const tk = translator('analytics');

// An outline of a daily chart's shape, not sample data: it has no values or readouts.
const PREVIEW_PATH = 'M 0,62 C 60,58 90,40 150,44 S 250,22 320,30 S 420,12 480,16 L 480,80 L 0,80 Z';

/**
 * Nothing to read in the window: a muted, dashed outline of the charts with a short heading, and
 * the way forward — the board, or a wider range when work happened before it (upstream's
 * empty and low-data overview states).
 */
export function AnalyticsEmptyState({
  hasHistory,
  rangeDays,
  boardPath,
  onWiden,
}: {
  /** The Factory has run work before, just not in this window. */
  hasHistory: boolean;
  rangeDays: number;
  boardPath: string;
  /** Present when a wider preset exists. */
  onWiden?: () => void;
}) {
  return (
    <div data-testid="analytics-empty-state" className="relative grid min-h-52 place-items-center overflow-hidden rounded-xl">
      <svg
        aria-hidden="true"
        viewBox="0 0 480 80"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <path
          d={PREVIEW_PATH}
          fill="var(--fill-subtle)"
          stroke="var(--border-strong)"
          strokeWidth="1"
          strokeDasharray="5 5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="relative">
        <EmptyState
          as="h2"
          iconSlot={null}
          titleSlot={hasHistory ? tk('empty.rangeTitle', { count: rangeDays }) : tk('empty.title')}
          descriptionSlot={hasHistory ? tk('empty.rangeDescription') : tk('empty.description')}
          actionSlot={
            <div className="flex flex-wrap justify-center gap-2">
              {hasHistory && onWiden ? (
                <Button size="sm" variant="ghost" onClick={onWiden}>
                  {tk('empty.wider')}
                </Button>
              ) : null}
              <Button size="sm" render={<Link to={boardPath} />}>
                {tk('empty.openBoard')}
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}
