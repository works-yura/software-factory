import { createBoardRegistry } from '@factory/core';
import type { BoardRegistry, InstalledBoard } from '@factory/core';

import { workBoard } from './work/board.ts';

export { createDefaultBoardRegistry, defaultBoards } from './defaults.ts';
export {
  cardOwnsBranch,
  isSafeBranchName,
  isWorkItemBranch,
  newestOwnedOpenPullRequestNumber,
  pullRequestBranch,
  legacyGithubWorkItemBranch,
  mergeRequestNumberFromBranch,
  pullRequestNumberFromBranch,
  workItemBranch,
  workItemNumber,
  workItemThreadTitle,
} from './shared/work-item-branch.ts';
export type { WorkItemBranchInput, WorkItemBranchSource } from './shared/work-item-branch.ts';
export { AUDIT_CONTEXT, AUDIT_SKILL, AUDITS_LEGACY_PHASE_RENAMES, auditsBoard, isAuditsBoardPhase } from './audits/board.ts';
export type { AuditsBoardPhase } from './audits/board.ts';
export { AUDIT_PROFILES, AUDIT_SEVERITIES, auditProfile, isUrgentFinding } from './audits/profiles.ts';
export type { AuditProfile, AuditSeverity } from './audits/profiles.ts';
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
export { BUILD_OBJECTIVE, OWN_CARD_HAND_OFF, workBoard } from './work/board.ts';
export type { WorkBoardPhase } from './work/board.ts';
export {
  LEGACY_SELF_REVIEW_PHASE,
  SELF_REVIEW_BUILD_NEXT_PHASES,
  SELF_REVIEW_BUILD_OBJECTIVE,
  selfReviewWorkBoard,
} from './work/legacy-self-review.ts';
export {
  buildDocsGuidance,
  changeFolderOf,
  DOCS_SKILL,
  docsSyncArguments,
  isDocsSyncCard,
  PRODUCT_CHANGE_KEY,
  PRODUCT_DOCS_SYNC_KEY,
  productChangeOf,
} from './work/docs.ts';
export { workLaneForRole, workStageCarries } from './work/legacy-plan-role.ts';

/** A registry with Work installed, plus any boards the host adds. */
export function createPipelines(boards: readonly InstalledBoard[] = []): BoardRegistry {
  return createBoardRegistry({ boards: [workBoard, ...boards] });
}
