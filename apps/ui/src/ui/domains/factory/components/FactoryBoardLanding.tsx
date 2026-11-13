import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { LoadErrorState } from '../../../ui/LoadErrorState';
import { useSidebarHeaderSlots } from '../../chat/components/useSidebarHeaderSlots';
import { orderedBoards } from '../boardCatalog';
import { rememberedBoardPath } from '../services/boardViews';
import { translator } from '../../../i18n/t';

const tk = translator('board');

export function FactoryBoardLanding({ factoryId }: { factoryId: string | undefined }) {
  const catalog = useBoardCatalog(factoryId);
  const first = catalog.isSuccess ? orderedBoards(catalog.data)[0] : undefined;
  if (first && factoryId) return <Navigate to={rememberedBoardPath(factoryId, first.id)} replace />;

  return (
    <BoardLandingLayout>
      {catalog.isPending ? (
        <p role="status">{tk('landing.loading')}</p>
      ) : catalog.isError ? (
        <LoadErrorState
          title={tk('landing.loadFailed')}
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
          retrying={catalog.isFetching}
        />
      ) : (
        <EmptyState variant="fill" titleSlot={tk('landing.noBoards')} />
      )}
    </BoardLandingLayout>
  );
}

// A page header, so a collapsed sidebar can still be reopened from here (useSidebarHeaderSlots). `fit` gives the
// skeleton and the centered states the page's full height.
function BoardLandingLayout({ children }: { children: ReactNode }) {
  const slots = useSidebarHeaderSlots();
  return (
    <PageLayout variant="fit" {...slots}>
      {children}
    </PageLayout>
  );
}
