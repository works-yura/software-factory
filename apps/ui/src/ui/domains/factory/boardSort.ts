import { BOARD_SORTS } from './boardOrder';
import type { BoardSort } from './boardOrder';
import { lazyLabels } from '../../i18n/lazy';

export const BOARD_SORT_QUERY = 'sort';

export const DEFAULT_BOARD_SORT: BoardSort = 'recent';

export const BOARD_SORT_LABELS: Readonly<Record<BoardSort, string>> = lazyLabels(
  BOARD_SORTS,
  sort => `board:sort.${sort}`,
);

export function boardSortOptions(currentUserId?: string): { value: BoardSort; label: string }[] {
  return BOARD_SORTS.filter(sort => sort !== 'recent-mine' || currentUserId).map(sort => ({
    value: sort,
    label: BOARD_SORT_LABELS[sort],
  }));
}

export function isBoardSort(value: string): value is BoardSort {
  return BOARD_SORTS.some(sort => sort === value);
}

export function boardSortFromParams(params: URLSearchParams, currentUserId?: string): BoardSort {
  const value = params.get(BOARD_SORT_QUERY);
  if (!value || !isBoardSort(value)) return DEFAULT_BOARD_SORT;
  return value === 'recent-mine' && !currentUserId ? DEFAULT_BOARD_SORT : value;
}

export function boardSortParams(current: URLSearchParams, sort: BoardSort): URLSearchParams {
  const next = new URLSearchParams(current);
  if (sort === DEFAULT_BOARD_SORT) next.delete(BOARD_SORT_QUERY);
  else next.set(BOARD_SORT_QUERY, sort);
  return next;
}
