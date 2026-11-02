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

/** Every Work phase: a card may move from any phase to any other; the transition policy guards the moves. */
const ALL_PHASES: readonly WorkBoardPhase[] = [
  'intake',
  'triage',
  'planning',
  'tests',
  'execute',
  'review',
  'done',
  'canceled',
];

export const workBoard = defineBoard<'work', Record<WorkBoardPhase, BoardPhaseDefinition<WorkBoardPhase>>>({
  id: 'work',
  name: 'Work',
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
      name: 'Intake',
      kind: 'resting',
      nextPhases: ALL_PHASES,
    },
    triage: {
      name: 'Triage',
      kind: 'working',
      runner: { context: 'triage' },
      nextPhases: ALL_PHASES,
      onEnter: {
        issue: triageIssueEntry,
        gitlabIssue: investigateTriagedGitLabIssue,
        manual: investigateTriagedClickUpTask,
      },
    },
    planning: {
      name: 'Planning',
      kind: 'working',
      // Planning and Building share one session, so the builder keeps the plan's context.
      runner: { context: 'work' },
      nextPhases: ALL_PHASES,
      onEnter: onEveryWorkSource(planWorkItem),
    },
    tests: {
      name: 'Tests',
      // Its own seat: the tester writes and commits the failing tests, never the code that passes them.
      kind: 'working',
      runner: { context: 'tester' },
      nextPhases: ALL_PHASES,
      onEnter: onEveryWorkSource(writeTests),
    },
    execute: {
      name: 'Building',
      kind: 'working',
      runner: { context: 'work' },
      nextPhases: ALL_PHASES,
      onEnter: onEveryWorkSource(buildWorkItem),
    },
    review: {
      name: 'Review',
      // The builder's seat carries Review: it answers feedback on its own change request.
      // With self-review on, entering Review first runs an independent reviewer in its own
      // review seat on the pushed branch; on approve the builder opens the change request here.
      kind: 'working',
      runner: { context: 'work' },
      nextPhases: ALL_PHASES,
      onEnter: onEveryWorkSource(selfReviewWorkItem),
    },
    done: {
      name: 'Done',
      kind: 'terminal',
      nextPhases: ALL_PHASES,
      onEnter: { issue: completeIssue },
    },
    canceled: {
      name: 'Canceled',
      kind: 'terminal',
      nextPhases: ALL_PHASES,
    },
  },
});

export function isWorkBoardPhase(value: string): value is WorkBoardPhase {
  return Object.hasOwn(workBoard.phases, value);
}
