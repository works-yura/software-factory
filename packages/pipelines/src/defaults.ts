import { createBoardRegistry } from '@factory/core';
import type { BoardRegistry, InstalledBoard } from '@factory/core';
import { workBoard } from './work/board.ts';

/**
 * The boards Factory installs unless a deployment opts out. The legacy Review board was retired:
 * pull and merge requests are reviewed in Work › PR review. Acceptance is a v4 addition and
 * stays opt-in.
 */
export const defaultBoards = [workBoard] as const;

/** v3 `createBoardRegistry`: Work first, then `boards`, unless `includeDefaultBoards` is false. */
export function createDefaultBoardRegistry(
  options: { boards?: readonly InstalledBoard[]; includeDefaultBoards?: boolean } = {},
): BoardRegistry {
  return createBoardRegistry({
    boards: [...(options.includeDefaultBoards === false ? [] : defaultBoards), ...(options.boards ?? [])],
  });
}
