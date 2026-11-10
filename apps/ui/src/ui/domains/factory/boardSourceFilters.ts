import type { BoardFilterState } from './boardFilters';
import { cardHasPullRequest } from './services/workItems';
import type { WorkItem, WorkItemSource } from './services/workItems';
import { lazyOption } from '../../i18n/lazy';

/** The source filter value for cards carrying a pull or merge request; where `/review` now leads. */
export const PULL_REQUEST_SOURCE_FILTER = 'pull-request';

export const BOARD_SOURCE_OPTIONS = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  lazyOption('manual', 'board:sourceFilter.manual'),
  // Not a provider: any card carrying a pull or merge request, its own or attached to its issue.
  lazyOption(PULL_REQUEST_SOURCE_FILTER, 'board:sourceFilter.pullRequests'),
];

type BoardSourceFilters = Pick<BoardFilterState, 'source'>;

export function boardSource(source: WorkItemSource): string {
  return source.split('-')[0];
}

/** Sources the board shows; empty means all. */
export function pickedBoardSources(filters: BoardSourceFilters): ReadonlySet<string> {
  return filters.source;
}

/** Source filters determine which intake feeds to browse. */
export function hasBoardSourceFilters(filters: BoardSourceFilters): boolean {
  return pickedBoardSources(filters).size > 0;
}

export function cardMatchesSourceFilters(
  card: Pick<WorkItem, 'source' | 'workItem'>,
  filters: BoardSourceFilters,
): boolean {
  const sources = pickedBoardSources(filters);
  if (sources.size === 0 || sources.has(boardSource(card.source))) return true;
  return sources.has(PULL_REQUEST_SOURCE_FILTER) && cardHasPullRequest(card);
}
