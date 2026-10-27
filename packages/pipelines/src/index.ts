import { createBoardRegistry } from '@factory/core';
import type { BoardRegistry, InstalledBoard } from '@factory/core';

import { acceptanceBoard } from './acceptance/board.ts';
import { isReviewBoardPhase, reviewBoard } from './review/board.ts';
import { isWorkBoardPhase, workBoard } from './work/board.ts';

export { acceptanceBoard } from './acceptance/board.ts';
export { createDefaultBoardRegistry, defaultBoards } from './defaults.ts';
export { isReviewBoardPhase, reviewBoard } from './review/board.ts';
export { hasRecordedVerdict } from './review/phase-rules.ts';
export type { ReviewBoardPhase } from './review/board.ts';
export {
  mergeRequestNumberFromBranch,
  pullRequestNumberFromBranch,
  workItemBranch,
  workItemNumber,
  workItemThreadTitle,
} from './shared/work-item-branch.ts';
export type { WorkItemBranchInput, WorkItemBranchSource } from './shared/work-item-branch.ts';
export { isWorkBoardPhase, workBoard } from './work/board.ts';
export type { WorkBoardPhase } from './work/board.ts';
export { SELF_REVIEW_ROUND_LIMIT } from './work/phase-rules.ts';
export { openApprovedChangeRequest } from './work/tool-rules.ts';

/** A registry with Work, Review, and Acceptance installed, plus any boards the host adds. */
export function createPipelines(boards: readonly InstalledBoard[] = []): BoardRegistry {
  return createBoardRegistry({ boards: [workBoard, reviewBoard, acceptanceBoard, ...boards] });
}

export function allowsBuiltInBoardTransition(board: 'work' | 'review', from: string, to: string): boolean {
  if (board === 'work') {
    return isWorkBoardPhase(from) && isWorkBoardPhase(to) && workBoard.allowsTransition(from, to);
  }
  return isReviewBoardPhase(from) && isReviewBoardPhase(to) && reviewBoard.allowsTransition(from, to);
}
