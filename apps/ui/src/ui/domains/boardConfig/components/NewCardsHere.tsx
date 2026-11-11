import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Link } from 'react-router';

import { DEFAULT_BOARD_ID } from '@factory/core/boards/default-board';
import type { InstalledBoardInfo, IntakeRouteInfo } from '../../../../api/types';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useIntakeRoutesQuery } from '../../../../hooks/useIntakeRoutes';
import { translator } from '../../../i18n/t';
import { SettingsSubsection } from '../../settings/components/SettingsSubsection';
import { NEW_CARD_ROUTES_ANCHOR, settingsSectionPath } from '../../settings/settingsSections';

const tk = translator('boardConfig');

/** Whether a route places new cards; every other route only moves cards already on a board. */
function placesNewCards(route: Pick<IntakeRouteInfo, 'on'>): boolean {
  return route.on.includes('work_item.created');
}

/** Whether `route` places every new card that reaches it, like the default "Everything else" route. */
function catchesEveryArrival(route: IntakeRouteInfo): boolean {
  return route.enabled && route.when === null && placesNewCards(route) && !route.target.joinClosedIssue;
}

/**
 * How many intake routes land new cards on this board. Routes are one Factory-wide ordered list, so they are listed
 * and edited in Work Intake; routes below the first one taking every new card never place a card and aren't counted.
 */
export function NewCardsHere({ factoryId, board }: { factoryId: string; board: InstalledBoardInfo }) {
  const query = useIntakeRoutesQuery(factoryId);
  const boards = useBoardCatalog(factoryId).data ?? [];
  const arrivals = (query.data ?? []).filter(route => route.enabled && placesNewCards(route));
  const catchAllIndex = arrivals.findIndex(catchesEveryArrival);
  const reachable = catchAllIndex === -1 ? arrivals : arrivals.slice(0, catchAllIndex + 1);
  // A route joining a pull request to its issue's card adds no card, so it isn't counted.
  const count = reachable.filter(route => !route.target.joinClosedIssue && route.target.boardKey === board.id).length;
  const defaultBoard = boards.find(candidate => candidate.id === DEFAULT_BOARD_ID) ?? boards[0];
  const takesLeftovers = catchAllIndex === -1 && defaultBoard?.id === board.id;

  return (
    <SettingsSubsection
      title={tk('newCards.title')}
      action={
        <Button
          size="sm"
          variant="ghost"
          render={<Link to={settingsSectionPath(factoryId, 'intake', NEW_CARD_ROUTES_ANCHOR)} />}
        >
          {tk('newCards.editRoutes')}
        </Button>
      }
    >
      <Txt as="p" variant="caption" tone="muted" role={query.isError ? 'alert' : 'status'}>
        {statusText(query, count, takesLeftovers)}
      </Txt>
    </SettingsSubsection>
  );
}

function statusText(query: { isPending: boolean; isError: boolean }, count: number, takesLeftovers: boolean) {
  if (query.isPending) return tk('newCards.loading');
  if (query.isError) return tk('newCards.failed');
  if (count === 0) return takesLeftovers ? tk('newCards.onlyLeftovers') : tk('newCards.none');
  return takesLeftovers ? tk('newCards.routedPlusLeftovers', { count }) : tk('newCards.routed', { count });
}
