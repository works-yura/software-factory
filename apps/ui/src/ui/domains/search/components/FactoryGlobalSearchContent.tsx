import { DEFAULT_BOARD_ID } from '@factory/core/boards/default-board';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { boardOf } from '../../factory/boardFlow';
import { CommandEmpty } from '@mastra/playground-ui/components/Command';
import {
  CommandPaletteBody,
  CommandPaletteFooter,
  CommandPaletteInput,
  CommandPaletteResults,
} from '@mastra/playground-ui/components/CommandPalette';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useState } from 'react';

import { useFactoriesQuery } from '../../../../hooks/useFactories';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { boardCardState, busyCardMoveRefusal, canStartRun } from '../../factory/boardCardState';
import { currentItemStage, itemStageLabel } from '../../factory/boardStages';
import { candidatePayload } from '../../factory/boardDrag';
import { cardMoves } from '../../factory/cardPrimaryAction';
import { useBoardItems } from '../../factory/hooks/useBoardItems';
import { useBoardRuns } from '../../factory/hooks/useBoardRuns';
import { useItemDecisions } from '../../factory/hooks/useBoardDecisions';
import { useGlobalSearchIntake } from '../hooks/useGlobalSearchIntake';
import { useGlobalSearchNavigation } from '../hooks/useGlobalSearchNavigation';
import { useGlobalSearchSessions } from '../hooks/useGlobalSearchSessions';
import { useGlobalSearchWorkItems } from '../hooks/useGlobalSearchWorkItems';
import { createSessionSearchGroups, createWorkItemSearchResults } from '../services/searchResults';
import {
  createGlobalSearchScopeCounts,
  isSessionScope,
  isWorkItemScope,
  scopeIncludes,
} from '../services/searchScopes';
import type { GlobalSearchScope } from '../services/searchScopes';
import { GlobalSearchFactoriesResults } from './GlobalSearchFactoriesResults';
import { GlobalSearchNavigationResults } from './GlobalSearchNavigationResults';
import { GlobalSearchRail } from './GlobalSearchRail';
import { GlobalSearchSessionResults } from './GlobalSearchSessionResults';
import { GlobalSearchSessionsStatus } from './GlobalSearchSessionsStatus';
import { GlobalSearchWorkItemResults } from './GlobalSearchWorkItemResults';
import { GlobalSearchWorkItemsStatus } from './GlobalSearchWorkItemsStatus';
import { useTranslation } from 'react-i18next';

export function FactoryGlobalSearchContent({ factoryId, closeSearch }: { factoryId: string; closeSearch: () => void }) {
  const { t } = useTranslation('search');
  const currentUserId = useFactoryAuth().data?.user?.userId;
  const factories = useFactoriesQuery().data ?? [];
  const activeFactory = factories.find(factory => factory.id === factoryId);
  const repositoryIds = activeFactory?.repositories.map(repository => repository.projectRepositoryId) ?? [];
  const searchableFactoryId = repositoryIds.length > 0 ? factoryId : undefined;
  const sessions = useGlobalSearchSessions(searchableFactoryId);
  const [query, setQuery] = useState('');
  const intake = useGlobalSearchIntake(factoryId, activeFactory?.repositories ?? []);
  const workItems = useGlobalSearchWorkItems(searchableFactoryId, query, intake.candidates);
  const toastFailureAfterPaletteCloses = (message: string) => toast.error(message);
  const catalog = useBoardCatalog(searchableFactoryId);
  const defaultBoard = catalog.data?.find(board => board.id === DEFAULT_BOARD_ID);
  // Unfiled candidates come from the intake feed, which files onto the default board.
  const workBoard = useBoardItems({
    factoryProjectId: searchableFactoryId,
    kind: DEFAULT_BOARD_ID,
    currentUserId,
    onFailure: toastFailureAfterPaletteCloses,
    items: workItems.loaded,
  });
  const runs = useBoardRuns({ factoryProjectId: factoryId, refetchItems: workItems.refetch });
  const { effectByItem } = useItemDecisions(searchableFactoryId);
  const { selectPath } = useGlobalSearchNavigation(closeSearch);
  const [activeScope, setActiveScope] = useState<GlobalSearchScope>('all');

  const sessionGroups = createSessionSearchGroups({
    factoryId,
    repositories: sessions.repositories,
    workItems: workItems.withSessions,
    boards: catalog.data,
  });
  const unstartedItems = createWorkItemSearchResults({
    factoryId,
    workItems: workItems.unstarted,
    candidates: workItems.candidates,
    boards: catalog.data,
  });
  const counts = createGlobalSearchScopeCounts({
    work: sessionGroups.work.length,
    review: sessionGroups.review.length,
    items: workItems.count,
    user: sessionGroups.user.length,
    factories: factories.length,
  });
  const sessionsPending = sessions.pending || workItems.pending;
  const hasRepositories = repositoryIds.length > 0;

  return (
    <>
      <CommandPaletteInput
        autoFocus
        onValueChange={setQuery}
        placeholder={t('input.placeholder')}
        rightSlot={<Kbd>Esc</Kbd>}
      />

      <CommandPaletteBody>
        <GlobalSearchRail activeScope={activeScope} counts={counts} onScopeChange={setActiveScope} />
        <CommandPaletteResults
          aria-label={t('results')}
          footer={<CommandPaletteFooter label={t('footer')} />}
        >
          {!sessionsPending && !intake.pending && <CommandEmpty>{t('empty')}</CommandEmpty>}
          {scopeIncludes(activeScope, 'navigation') && (
            <GlobalSearchNavigationResults factoryId={factoryId} onSelect={selectPath} />
          )}
          {scopeIncludes(activeScope, 'work') && (
            <GlobalSearchSessionResults title={t('scopes.work')} results={sessionGroups.work} onSelect={selectPath} />
          )}
          {scopeIncludes(activeScope, 'review') && (
            <GlobalSearchSessionResults title={t('scopes.review')} results={sessionGroups.review} onSelect={selectPath} />
          )}
          {scopeIncludes(activeScope, 'items') && (
            <GlobalSearchWorkItemResults
              results={unstartedItems}
              onSelect={result => {
                const target = result.target;
                if (target.kind === 'candidate') {
                  // Until the default board's catalog entry loads there is nowhere to file it: stay open.
                  if (!defaultBoard) {
                    toast.error(t('boardStillLoading'));
                    return;
                  }
                  // A board with no move for it still takes it, filed in its initial phase.
                  const [move] = cardMoves(target.candidate, target.candidate.column, defaultBoard);
                  closeSearch();
                  workBoard.handleDrop(
                    candidatePayload(target.candidate),
                    move?.stage ?? defaultBoard.initialPhase,
                    'card_action',
                  );
                  return;
                }
                const item = target.item;
                const board = workBoard;
                const definition = boardOf(catalog.data, item);
                const movingTo = board.evaluatingStages.get(item.id);
                const { owner } = boardCardState({
                  decision: effectByItem.get(item.id),
                  moving:
                    movingTo === undefined
                      ? undefined
                      : { stage: movingTo, label: itemStageLabel(item, movingTo, definition) },
                  preparing: runs.preparingFor(item.id),
                });
                if (!canStartRun(owner.kind)) {
                  closeSearch();
                  toast.error(busyCardMoveRefusal());
                  return;
                }
                // Moves read from the phase the card sits in (its furthest, as its label shows), not its board's first.
                const stage = currentItemStage(item, definition);
                const [move] = definition && stage !== undefined ? cardMoves(item, stage, definition) : [];
                if (move) {
                  closeSearch();
                  board.move(item.id, move.stage);
                  return;
                }
                void runs
                  .openOrCreateSession(item)
                  .then(() => closeSearch())
                  .catch(error =>
                    toast.error(error instanceof Error ? error.message : t('sessionStartFailed')),
                  );
              }}
            />
          )}
          {scopeIncludes(activeScope, 'user') && (
            <GlobalSearchSessionResults title={t('scopes.user')} results={sessionGroups.user} onSelect={selectPath} />
          )}
          {isSessionScope(activeScope) && hasRepositories && (
            <GlobalSearchSessionsStatus pending={sessionsPending} failed={sessions.failed} onRetry={sessions.retry} />
          )}
          {isWorkItemScope(activeScope) && hasRepositories && (
            <GlobalSearchWorkItemsStatus
              boardFailed={workItems.failed}
              intakeFailed={intake.failed}
              onRetry={() => {
                workItems.retry();
                intake.retry();
              }}
            />
          )}
          {scopeIncludes(activeScope, 'factories') && (
            <GlobalSearchFactoriesResults factories={factories} activeFactoryId={factoryId} onSelect={selectPath} />
          )}
        </CommandPaletteResults>
      </CommandPaletteBody>
    </>
  );
}
