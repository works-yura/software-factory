import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useFactoryAttentionHistory } from '../../../../../../hooks/useFactoryAttention';
import type { FactoryAttentionKind, FactoryAttentionView } from '../../../services/attention';
import { AttentionItemRow } from '../../AttentionItemRow';
import { PANEL } from '../../panel';
import { RepositoryPickerDialog } from '../../RepositoryPickerDialog';
import { useAttentionItemActions } from '../../useAttentionItemActions';

/** Rows before the list folds, so a backlog cannot push the feed off the screen. */
const COLLAPSED_ROWS = 5;

export function AttentionList({
  factoryId,
  view,
  kinds,
  emptySlot,
}: {
  factoryId: string;
  view: FactoryAttentionView;
  kinds: readonly FactoryAttentionKind[];
  emptySlot: ReactNode;
}) {
  const { t } = useTranslation('activity');
  const [expanded, setExpanded] = useState(false);
  const attention = useFactoryAttentionHistory(factoryId, view, kinds);
  const actions = useAttentionItemActions(factoryId);

  if (attention.isPending) {
    return <Skeleton role="status" aria-label={t('needsYou.loading')} className="h-14 w-full rounded-xl" />;
  }

  if (attention.isError) {
    return (
      <Notice variant="destructive">
        <span>{t('needsYou.loadError')}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void attention.refetch()}>
          {t('feed.tryAgain')}
        </Button>
      </Notice>
    );
  }

  const items = attention.data.pages.flatMap(page => page.items);
  if (items.length === 0 && !attention.hasNextPage) return emptySlot;

  const shown = expanded ? items : items.slice(0, COLLAPSED_ROWS);
  const foldedCount = items.length - shown.length;
  const canLoadOlder = foldedCount === 0 && attention.hasNextPage;

  return (
    <>
      <ul className={`${PANEL} m-0 flex list-none flex-col px-3 py-1`}>
        {shown.map(item => (
          <li key={item.key}>
            <AttentionItemRow factoryId={factoryId} {...actions.rowProps(item)} />
          </li>
        ))}
        {foldedCount > 0 ? (
          <li className="py-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(true)}>
              {t('needsYou.showMore', { count: foldedCount })}
            </Button>
          </li>
        ) : null}
        {canLoadOlder ? (
          <li className="py-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={attention.isFetchingNextPage}
              onClick={() => void attention.fetchNextPage()}
            >
              {attention.isFetchingNextPage ? t('needsYou.loadingOlder') : t('needsYou.loadOlder')}
            </Button>
          </li>
        ) : null}
      </ul>
      {actions.repositorySelection ? (
        <RepositoryPickerDialog
          repositories={actions.repositories}
          onClose={actions.closeRepositorySelection}
          onSelect={actions.selectRepository}
        />
      ) : null}
    </>
  );
}
