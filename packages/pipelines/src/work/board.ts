import { defineBoard } from '@factory/core';
import type { BoardPhaseDefinition, FactoryRuleHandler, FactoryRuleSource, FactoryStageRuleContext } from '@factory/core';

import {
  buildWorkItem,
  completeIssue,
  investigateTriagedClickUpTask,
  investigateTriagedGitLabIssue,
  planWorkItem,
  selfReviewWorkItem,
  triageIssueEntry,
  writeTests,
} from './phase-rules.ts';
import { advanceApprovedPlan, openApprovedChangeRequest } from './tool-rules.ts';
import { workTransitionPolicy } from './transition-policy.ts';

/** Rule sources that land on Work; pull requests and merge requests go to Review. */
const WORK_RULE_SOURCES = ['issue', 'gitlabIssue', 'manual'] as const;

function onEveryWorkSource(
  handler: FactoryRuleHandler<FactoryStageRuleContext>,
): Partial<Record<FactoryRuleSource, FactoryRuleHandler<FactoryStageRuleContext>>> {
  return Object.fromEntries(WORK_RULE_SOURCES.map(source => [source, handler]));
}

export type WorkBoardPhase = 'intake' | 'triage' | 'planning' | 'tests' | 'execute' | 'review' | 'done' | 'canceled';

/** Work lets a card move between any two phases; the transition policy guards the moves. */
const anyPhase = {
  intake: 'intake',
  triage: 'triage',
  planning: 'planning',
  tests: 'tests',
  execute: 'execute',
  review: 'review',
  done: 'done',
  canceled: 'canceled',
} as const;

export const workBoard = defineBoard<'work', Record<WorkBoardPhase, BoardPhaseDefinition<WorkBoardPhase>>>({
  id: 'work',
  title: 'Work',
  initialPhase: 'intake',
  transitionPolicy: workTransitionPolicy,
  sourceClosed: { completed: 'done', canceled: 'canceled' },
  changeRequests: { build: 'execute', review: 'review', merged: 'done' },
  triageClassification: true,
  // Bugs and feature requests: the tester commits the failing test, the builder may not touch it.
  reproductionTest: { record: 'tests', protect: 'execute' },
  tools: {
    submit_plan: { onResult: advanceApprovedPlan },
    factory_record_review_verdict: { onResult: openApprovedChangeRequest },
  },
  phases: {
    intake: {
      title: 'Intake',
      kind: 'resting',
      outcomes: anyPhase,
    },
    triage: {
      title: 'Triage',
      kind: 'working',
      role: 'triage',
      outcomes: anyPhase,
      onEnter: {
        issue: triageIssueEntry,
        gitlabIssue: investigateTriagedGitLabIssue,
        manual: investigateTriagedClickUpTask,
      },
    },
    planning: {
      title: 'Planning',
      kind: 'working',
      role: 'plan',
      outcomes: anyPhase,
      onEnter: onEveryWorkSource(planWorkItem),
    },
    tests: {
      title: 'Tests',
      // Its own seat: the tester writes and commits the failing tests, never the code that passes them.
      kind: 'working',
      role: 'tester',
      outcomes: anyPhase,
      onEnter: onEveryWorkSource(writeTests),
    },
    execute: {
      title: 'Building',
      kind: 'working',
      role: 'work',
      outcomes: anyPhase,
      onEnter: onEveryWorkSource(buildWorkItem),
    },
    review: {
      title: 'Review',
      // The builder's seat carries Review: it answers feedback on its own change request.
      // With self-review on, entering Review first runs an independent reviewer in its own
      // review seat on the pushed branch; on approve the builder opens the change request here.
      kind: 'working',
      role: 'work',
      outcomes: anyPhase,
      onEnter: onEveryWorkSource(selfReviewWorkItem),
    },
    done: {
      title: 'Done',
      kind: 'terminal',
      outcomes: anyPhase,
      onEnter: { issue: completeIssue },
    },
    canceled: {
      title: 'Canceled',
      kind: 'terminal',
      outcomes: anyPhase,
    },
  },
});

export function isWorkBoardPhase(value: string): value is WorkBoardPhase {
  return Object.hasOwn(workBoard.phases, value);
}
