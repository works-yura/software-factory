import { compileBoardDefinition, isPullRequestCard } from '@factory/core';
import type { BoardPhaseDefinition, FactoryRuleHandler, FactoryRuleSource, FactoryStageRuleContext } from '@factory/core';

import {
  buildWorkItem,
  completeIssue,
  investigateTriagedImportedTask,
  investigateTriagedGitLabIssue,
  planWorkItem,
  selfReviewWorkItem,
  triageIssueEntry,
} from './phase-rules.ts';
import { reviewPullRequest } from '../review/phase-rules.ts';
import { advanceApprovedPlan, openApprovedChangeRequest } from './tool-rules.ts';

/** Rule sources of Work's own work items; pull and merge requests are reviewed in `pr-review` (or on Review). */
const WORK_RULE_SOURCES = ['issue', 'gitlabIssue', 'manual'] as const;

function onEveryWorkSource(
  handler: FactoryRuleHandler<FactoryStageRuleContext>,
): Partial<Record<FactoryRuleSource, FactoryRuleHandler<FactoryStageRuleContext>>> {
  return Object.fromEntries(WORK_RULE_SOURCES.map(source => [source, handler]));
}

export type WorkBoardPhase =
  | 'intake'
  | 'triage'
  | 'planning'
  | 'execute'
  | 'review'
  | 'pr-review'
  | 'done'
  | 'canceled';

/** A pull request's own card on Work is only reviewed: it never enters these phases, whoever moves it. */
const NON_PULL_REQUEST_PHASES: ReadonlySet<string> = new Set(['triage', 'planning', 'execute', 'review']);

/**
 * Why a move breaks the shape of a card on Work, or undefined when it does not: a pull request's
 * card is only reviewed, and PR review holds only pull request cards. `nextPhases` cannot say
 * this: Intake leads to both Triage and PR review, and which one fits depends on the card.
 */
export function workPullRequestCardRejection(isPullRequest: boolean, toStage: string): string | undefined {
  if (!isPullRequest && toStage === 'pr-review')
    return 'PR review holds only pull request cards; this work item goes to Review after Building.';
  if (!isPullRequest || !NON_PULL_REQUEST_PHASES.has(toStage)) return undefined;
  return `A pull request card is reviewed on the Work board; it cannot enter ${toStage}. Move it to pr-review, done, or canceled.`;
}

export const workBoard = compileBoardDefinition<'work', Record<WorkBoardPhase, BoardPhaseDefinition<WorkBoardPhase>>>({
  id: 'work',
  name: 'Work',
  initialPhase: 'intake',
  // The one rule `nextPhases` can't say: a pull request's own card is only reviewed, and PR review
  // holds only pull request cards. (Upstream checks this in the transition service; v4's engine
  // knows no board, so Work states it here.)
  transitionPolicy: ({ item, toStage }) => {
    const reason = workPullRequestCardRejection(isPullRequestCard(item), toStage);
    return reason ? { type: 'reject', code: 'invalid_transition', reason } : undefined;
  },
  sourceClosed: { completed: 'done', canceled: 'canceled' },
  changeRequests: { build: 'execute', review: 'review', merged: 'done' },
  triageClassification: true,
  tools: {
    submit_plan: { onResult: advanceApprovedPlan },
    factory_record_review_verdict: { onResult: openApprovedChangeRequest },
  },
  phases: {
    intake: {
      name: 'Intake',
      kind: 'resting',
      // Never straight to Building or Review: a plan comes first, and Review is self-review of a
      // build. PR review takes a pull request's own card; Done is where a completed source closes it.
      nextPhases: ['triage', 'planning', 'pr-review', 'done', 'canceled'],
    },
    triage: {
      name: 'Triage',
      kind: 'working',
      runner: { context: 'triage' },
      // A confirmed bug goes to Planning; any other open issue waits in Intake for a person.
      nextPhases: ['intake', 'planning', 'done', 'canceled'],
      onEnter: {
        issue: triageIssueEntry,
        gitlabIssue: investigateTriagedGitLabIssue,
        manual: investigateTriagedImportedTask,
      },
    },
    planning: {
      name: 'Planning',
      kind: 'working',
      // Planning and Building share one session, so the builder keeps the plan's context.
      runner: { context: 'work' },
      nextPhases: ['execute', 'triage', 'intake', 'done', 'canceled'],
      // Its success moves the card into Building (advanceApprovedPlan); an agent cannot move it there itself.
      exitTool: { id: 'submit_plan', autoApprove: false },
      onEnter: onEveryWorkSource(planWorkItem),
    },
    execute: {
      name: 'Building',
      kind: 'working',
      runner: { context: 'work' },
      // Planning again when the build shows the plan was wrong.
      nextPhases: ['review', 'planning', 'done', 'canceled'],
      onEnter: onEveryWorkSource(buildWorkItem),
    },
    review: {
      name: 'Review',
      // The builder's seat carries Review: it answers feedback on its own change request.
      // With self-review on, entering Review first runs an independent reviewer in its own
      // review seat on the pushed branch; on approve the builder opens the change request here.
      kind: 'working',
      runner: { context: 'work' },
      // Self-review sends the card back to Building, or parks it in Intake at its round limit.
      nextPhases: ['execute', 'intake', 'done', 'canceled'],
      onEnter: onEveryWorkSource(selfReviewWorkItem),
    },
    'pr-review': {
      name: 'PR review',
      // A pull request's own card is reviewed here by the independent reviewer, in its own
      // review seat. Kept apart from Review, the builder's self-review, so a card never
      // reaches the builder's lanes through a pull request's.
      kind: 'working',
      runner: { context: 'work' },
      // Merged, closed, or set aside in Intake: it never reaches the builder's lanes.
      nextPhases: ['intake', 'done', 'canceled'],
      onEnter: {
        pullRequest: reviewPullRequest,
        gitlabPullRequest: reviewPullRequest,
      },
    },
    done: {
      name: 'Done',
      kind: 'terminal',
      // A review request on a finished pull request reopens its review.
      nextPhases: ['pr-review'],
      onEnter: { issue: completeIssue },
    },
    canceled: {
      name: 'Canceled',
      kind: 'terminal',
      // Revived into Intake; a pull request closed without merging and then reopened goes back to Review.
      nextPhases: ['intake', 'pr-review'],
    },
  },
});

export function isWorkBoardPhase(value: string): value is WorkBoardPhase {
  return Object.hasOwn(workBoard.phases, value);
}
