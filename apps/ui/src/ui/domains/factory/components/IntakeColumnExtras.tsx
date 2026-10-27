import type { IntakeFeed } from '../boardCandidates';
import { SKELETON_ROW_CLASS } from '../boardLayout';
import type { BoardLayout } from '../boardLayout';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { LoadMoreSentinel } from './LoadMoreSentinel';
import { translator } from '../../../i18n/t';

const tk = translator('board');

/**
 * Pagination for healthy candidate feeds. A failed single feed renders nothing;
 * combined feeds can still page their healthy providers without retrying errors.
 */
export function IntakeColumnExtras({
  feed,
  currentColumnLength,
  layout,
}: {
  feed?: IntakeFeed;
  currentColumnLength: number;
  layout: BoardLayout;
}) {
  if (!feed || (feed.error && !feed.retryFailed)) return null;

  return (
    <LoadMoreSentinel
      hasNextPage={Boolean(feed.hasNextPage)}
      isFetchingNextPage={Boolean(feed.isFetchingNextPage)}
      onLoadMore={() => void feed.fetchNextPage()}
      label={tk('intake.loadMore')}
      loadingIndicator={
        currentColumnLength > 0 ? (
          <SkeletonRows label={tk('intake.loadingMore')} rows={1} rowClassName={SKELETON_ROW_CLASS[layout]} />
        ) : (
          <span role="status" className="sr-only">
            {tk('intake.loadingMore')}
          </span>
        )
      }
    />
  );
}
