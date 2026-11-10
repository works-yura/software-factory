import { createBoardRegistry } from '@factory/core';
import type { BoardRegistry, InstalledBoard } from '@factory/core';
import { productBoard } from './product/board.ts';
import { workBoard } from './work/board.ts';

/**
 * The boards Factory installs unless a deployment opts out: Work, where code is built and
 * reviewed, and Product, where a request becomes a brief, a spec and Work's cards. The legacy
 * Review board was retired: pull and merge requests are reviewed in Work › PR review.
 */
export const defaultBoards = [workBoard, productBoard] as const;

/** v3 `createBoardRegistry`: the default boards first, then `boards`, unless `includeDefaultBoards` is false. */
export function createDefaultBoardRegistry(
  options: { boards?: readonly InstalledBoard[]; includeDefaultBoards?: boolean } = {},
): BoardRegistry {
  return createBoardRegistry({
    boards: [...(options.includeDefaultBoards === false ? [] : defaultBoards), ...(options.boards ?? [])],
  });
}
