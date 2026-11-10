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
export { isProductBoardPhase, PRODUCT_CONTEXT, PRODUCT_LEGACY_PHASE_RENAMES, productBoard } from './product/board.ts';
export type { ProductBoardPhase } from './product/board.ts';
export {
  checkProductDocumentStructure,
  PRODUCT_CHILDREN_KEY,
  PRODUCT_DOC_CHECKS_KEY,
  PRODUCT_DOCUMENT_FILES,
  PRODUCT_DOCUMENT_TYPES,
  PRODUCT_TASK_FIELDS,
  productChildWorkItemIds,
  productTaskProblems,
  productDocumentGateFailure,
  productDocumentPassed,
  recordedProductDocumentCheck,
  waivableProductSections,
  withProductChild,
  withProductDocumentCheck,
} from './product/documents.ts';
export type {
  ProductContradiction,
  ProductDocumentCheck,
  ProductDocumentType,
  ProductSectionWaiver,
} from './product/documents.ts';
export { isWorkBoardPhase, workBoard, workPullRequestCardRejection } from './work/board.ts';
export type { WorkBoardPhase } from './work/board.ts';
export {
  changeFolderOf,
  DOCS_SKILL,
  isDocsSyncCard,
  PRODUCT_CHANGE_KEY,
  PRODUCT_DOCS_SYNC_KEY,
  productChangeOf,
} from './work/docs.ts';
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
