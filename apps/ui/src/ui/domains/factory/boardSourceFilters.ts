import type { BoardFilterState } from './boardFilters';
import type { WorkItem, WorkItemSource } from './services/workItems';
import { lazyOption } from '../../i18n/lazy';

export const BOARD_SOURCE_OPTIONS = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  lazyOption('manual', 'board:sourceFilter.manual'),
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

export function cardMatchesSourceFilters(card: Pick<WorkItem, 'source'>, filters: BoardSourceFilters): boolean {
  const sources = pickedBoardSources(filters);
  return sources.size === 0 || sources.has(boardSource(card.source));
}
