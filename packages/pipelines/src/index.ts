import { createBoardRegistry } from '@factory/core';
import type { BoardRegistry, InstalledBoard } from '@factory/core';

import { isWorkBoardPhase, workBoard } from './work/board.ts';

export { createDefaultBoardRegistry, defaultBoards } from './defaults.ts';
export { hasRecordedVerdict, reviewPullRequest } from './work/pr-review-rules.ts';
export {
  isWorkItemBranch,
  legacyGithubWorkItemBranch,
  mergeRequestNumberFromBranch,
  pullRequestNumberFromBranch,
  workItemBranch,
  workItemNumber,
  workItemThreadTitle,
} from './shared/work-item-branch.ts';
export type { WorkItemBranchInput, WorkItemBranchSource } from './shared/work-item-branch.ts';
export { isWorkBoardPhase, workBoard, workPullRequestCardRejection } from './work/board.ts';
export type { WorkBoardPhase } from './work/board.ts';
export { workLaneForRole, workStageCarries } from './work/legacy-plan-role.ts';
export { SELF_REVIEW_ROUND_LIMIT } from './work/phase-rules.ts';
export { openApprovedChangeRequest } from './work/tool-rules.ts';

/** A registry with Work installed, plus any boards the host adds. */
export function createPipelines(boards: readonly InstalledBoard[] = []): BoardRegistry {
  return createBoardRegistry({ boards: [workBoard, ...boards] });
}

export function allowsBuiltInBoardTransition(board: 'work', from: string, to: string): boolean {
  return board === 'work' && isWorkBoardPhase(from) && isWorkBoardPhase(to) && workBoard.allowsTransition(from, to);
}
