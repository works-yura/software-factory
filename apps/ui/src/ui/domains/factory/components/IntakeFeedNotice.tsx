import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';

import { useApiConfig } from '../../../../api/config';
import type { IntakeFeed, IntakeSource } from '../boardCandidates';
import { BOARD_SOURCE_OPTIONS } from '../boardSourceFilters';
import { connectLinear, isLinearReauthError } from '../services/linear';
import { translator } from '../../../i18n/t';

const tk = translator('board');

/**
 * Why a column has no candidates when its feed failed. Without it the column
 * falls back to its empty state and reads as an empty backlog.
 */
export function IntakeFeedNotice({ source, feed }: { source?: IntakeSource; feed: IntakeFeed }) {
  const { baseUrl } = useApiConfig();
  if (!feed.error) return null;
  const label = BOARD_SOURCE_OPTIONS.find(option => option.value === source?.split('-')[0])?.label;

  return source === 'linear' && isLinearReauthError(feed.error) ? (
    <LinearReauthNotice onConnect={() => connectLinear(baseUrl)} />
  ) : (
    // A page that failed is not stored, so only fetchNextPage requests it again.
    <FeedFailureNotice
      message={label ? `${label}: ${feed.error.message}` : feed.error.message}
      onRetry={() =>
        void (feed.retryFailed ? feed.retryFailed() : feed.isFetchNextPageError ? feed.fetchNextPage() : feed.refetch())
      }
    />
  );
}

function LinearReauthNotice({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 p-1">
      <Txt tone="muted" as="span" variant="meta">
        {tk('intake.linearExpired')}
      </Txt>
      <Button size="sm" onClick={onConnect}>
        {tk('intake.connectLinear')}
      </Button>
    </div>
  );
}

function FeedFailureNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 p-1">
      <Txt as="p" role="alert" variant="meta" className="text-destructive-foreground m-0">
        {message}
      </Txt>
      <Button size="sm" onClick={onRetry}>
        {tk('intake.retry')}
      </Button>
    </div>
  );
}
