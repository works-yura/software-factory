import { createBoardRegistry } from '@factory/core';
import type { BoardRegistry, InstalledBoard } from '@factory/core';
import { reviewBoard, workBoard } from '@factory/pipelines';

/**
 * The boards v3 installed unless a deployment opted out. Acceptance is a v4
 * addition and stays opt-in, so a copied host keeps v3 behaviour.
 */
export const defaultBoards = [workBoard, reviewBoard] as const;

/** v3 `createBoardRegistry`: Work and Review first, then `boards`, unless `includeDefaultBoards` is false. */
export function createDefaultBoardRegistry(
  options: { boards?: readonly InstalledBoard[]; includeDefaultBoards?: boolean } = {},
): BoardRegistry {
  return createBoardRegistry({
    boards: [...(options.includeDefaultBoards === false ? [] : defaultBoards), ...(options.boards ?? [])],
  });
}
