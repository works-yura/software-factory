import { defineBoard } from '@factory/core';
import type { BoardPhaseDefinition, FactoryRuleHandler, FactoryRuleSource, FactoryStageRuleContext } from '@factory/core';

import { completeIssue, selfReviewWorkItem } from '../work/phase-rules.ts';
import { advanceApprovedPlanTo, openApprovedChangeRequest } from '../work/tool-rules.ts';
import { buildBugFix, planBugFix, triageBug, writeReproductionTest } from './phase-rules.ts';
import { bugTransitionPolicy } from './transition-policy.ts';

/** Bugs arrive from issues (routed by label) or are filed by hand. */
const BUG_RULE_SOURCES = ['issue', 'gitlabIssue', 'manual'] as const;

function onEveryBugSource(
  handler: FactoryRuleHandler<FactoryStageRuleContext>,
): Partial<Record<FactoryRuleSource, FactoryRuleHandler<FactoryStageRuleContext>>> {
  return Object.fromEntries(BUG_RULE_SOURCES.map(source => [source, handler]));
}

export type BugBoardPhase = 'intake' | 'triage' | 'planning' | 'tests' | 'execute' | 'review' | 'done' | 'canceled';

/** Like Work, a card may move between any two phases; the transition policy guards the moves. */
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

/**
 * Bug fixing as its own pipeline: confirm the bug, plan how to reproduce and fix it, prove it with
 * a failing test written in its own `tester` seat, fix it without touching that test, review, and
 * ship it as a pull or merge request. Triage, planning, building, and review use Work's roles, so
 * the triage classification, plan approval, self-review, and change-request machinery Work uses
 * applies to Bug cards through the same declarations.
 */
export const bugBoard = defineBoard<'bug', Record<BugBoardPhase, BoardPhaseDefinition<BugBoardPhase>>>({
  id: 'bug',
  title: 'Bug',
  initialPhase: 'intake',
  transitionPolicy: bugTransitionPolicy,
  sourceClosed: { completed: 'done', canceled: 'canceled' },
  changeRequests: { build: 'execute', review: 'review', merged: 'done' },
  triageClassification: true,
  reproductionTest: { record: 'tests', protect: 'execute' },
  tools: {
    // An approved plan goes to the reproduction test, never straight to the fix.
    submit_plan: { onResult: advanceApprovedPlanTo('tests') },
    factory_record_review_verdict: { onResult: openApprovedChangeRequest },
  },
  phases: {
    intake: { title: 'Intake', kind: 'resting', outcomes: anyPhase },
    triage: {
      title: 'Triage',
      kind: 'working',
      role: 'triage',
      outcomes: anyPhase,
      onEnter: onEveryBugSource(triageBug),
    },
    planning: {
      title: 'Planning',
      kind: 'working',
      role: 'plan',
      outcomes: anyPhase,
      onEnter: onEveryBugSource(planBugFix),
    },
    tests: {
      title: 'Reproduction test',
      // Its own seat: the tester writes and commits the failing test, never the fix.
      kind: 'working',
      role: 'tester',
      outcomes: anyPhase,
      onEnter: onEveryBugSource(writeReproductionTest),
    },
    execute: {
      title: 'Fix',
      kind: 'working',
      role: 'work',
      outcomes: anyPhase,
      onEnter: onEveryBugSource(buildBugFix),
    },
    review: {
      title: 'Review',
      // As on Work: the builder's seat carries Review and answers feedback on its own change
      // request; with self-review on, an independent reviewer approves the branch here first.
      kind: 'working',
      role: 'work',
      outcomes: anyPhase,
      onEnter: onEveryBugSource(selfReviewWorkItem),
    },
    done: { title: 'Done', kind: 'terminal', outcomes: anyPhase, onEnter: { issue: completeIssue } },
    canceled: { title: 'Canceled', kind: 'terminal', outcomes: anyPhase },
  },
});

export function isBugBoardPhase(value: string): value is BugBoardPhase {
  return Object.hasOwn(bugBoard.phases, value);
}
