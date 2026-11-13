import { pickedBoardSources, PULL_REQUEST_SOURCE_FILTER } from '@factory/work-items/card-source-filters';
import type { SourceFilters } from '@factory/work-items/card-source-filters';

import { lazyOption } from '../../i18n/lazy';

export { pickedBoardSources, PULL_REQUEST_SOURCE_FILTER };

export const BOARD_SOURCE_OPTIONS = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  lazyOption('manual', 'board:sourceFilter.manual'),
  // Not a provider: any card carrying a pull or merge request, its own or attached to its issue.
  lazyOption(PULL_REQUEST_SOURCE_FILTER, 'board:sourceFilter.pullRequests'),
];

/** Source filters determine which intake feeds to browse. */
export function hasBoardSourceFilters(filters: SourceFilters): boolean {
  return pickedBoardSources(filters).size > 0;
}
