import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MessageSquare, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { queryKeys } from '../../../../../api/keys';
import { useFactoryAuth } from '../../../../../hooks/useFactoryAuth';
import type { WorkItem } from '../../services/workItems';
import { CommentComposer } from './CommentComposer';
import { CommentList } from './CommentList';
import type { CommentQuoteDraft } from './quoteDraft';

/** Thread-surface feed view; chrome mirrors WorkspaceChangesPanel. */
export function WorkItemFeedPanel({
  item,
  factoryProjectId,
  visible,
  onBack,
}: {
  item: WorkItem;
  factoryProjectId: string | undefined;
  visible: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation('activity');
  const auth = useFactoryAuth();
  const queryClient = useQueryClient();
  const [quote, setQuote] = useState<CommentQuoteDraft>();

  return (
    <aside
      className="flex min-h-0 min-w-0 grow flex-col"
      aria-label={t('comments.panel')}
      data-testid="work-item-feed-panel"
    >
      <div className="flex min-h-10 items-center gap-1.5 px-1.5 py-1">
        <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label={t('comments.back')}>
          <ArrowLeft />
        </Button>
        <MessageSquare className="text-muted-foreground" size={14} />
        <Txt tone="ink" as="h2" variant="column">
          {t('comments.title')}
        </Txt>
        <Txt tone="muted" variant="meta" className="ml-auto">
          {t('comments.count', { count: item.commentCount })}
        </Txt>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('comments.refresh')}
          onClick={() => void queryClient.invalidateQueries({ queryKey: queryKeys.workItemCommentsRoot(item.id) })}
        >
          <RefreshCw />
        </Button>
      </div>
      <CommentList
        item={item}
        factoryProjectId={factoryProjectId}
        enabled={visible}
        currentUser={auth.data?.user}
        onQuote={setQuote}
        className="min-h-0 grow"
      />
      <div className="shrink-0">
        <CommentComposer
          workItemId={item.id}
          factoryProjectId={factoryProjectId}
          variant="thread"
          quote={quote}
          onDismissQuote={() => setQuote(undefined)}
        />
      </div>
    </aside>
  );
}
