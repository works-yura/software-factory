import { describe, expect, it } from 'vitest';

import { createBoardRegistry, resolveBoardChangeRequests, resolveBoardToolRule, resolvePhaseSemantics } from '@factory/core';
import type { FactoryRuleItemContext, FactoryStageRuleContext } from '@factory/core';

import { createPipelines } from '../index.ts';
import { workBoard } from '../work/board.ts';
import { bugBoard, isBugBoardPhase } from './board.ts';

function entry(
  stage: string,
  fromStage: string,
  overrides: { source?: FactoryRuleItemContext['source']; metadata?: Record<string, unknown>; selfReview?: boolean } = {},
): FactoryStageRuleContext {
  const source = overrides.source ?? 'github-issue';
  return {
    tenant: { orgId: 'org-1', projectId: 'project-1' },
    actor: { type: 'human', id: 'user-1' },
    ingress: { type: 'human', id: 'ingress-1' },
    cause: 'test',
    causalChain: [],
    configVersion: 'test',
    item: {
      id: 'item-1',
      source,
      sourceKey: 'github:10:issue:42',
      parentWorkItemId: null,
      title: 'Login button does nothing',
      url: source === 'gitlab-issue' ? 'https://gitlab.com/acme/app/-/issues/3' : 'https://github.com/acme/app/issues/42',
      stages: [stage],
      acceptedAt: null,
      metadata: { githubIssueNumber: 42, identifier: 'acme/app#3', ...overrides.metadata },
    },
    board: 'bug',
    itemRevision: 3,
    source: source === 'gitlab-issue' ? 'gitlabIssue' : 'issue',
    stage,
    fromStage,
    toStage: stage,
    ...(overrides.selfReview ? { selfReviewEnabled: true } : {}),
  };
}

describe('bug board definition', () => {
  it('installs next to Work, Review, and Acceptance without reserving their ids', () => {
    expect([...createPipelines([bugBoard]).keys()]).toEqual(['work', 'review', 'acceptance', 'bug']);
  });

  it('declares the bug lifecycle with the built-in roles', () => {
    expect(bugBoard.initialPhase).toBe('intake');
    expect(Object.keys(bugBoard.phases)).toEqual([
      'intake',
      'triage',
      'planning',
      'tests',
      'execute',
      'review',
      'done',
      'canceled',
    ]);
    expect(bugBoard.phaseKind('intake')).toBe('resting');
    expect(bugBoard.roleForPhase('triage')).toBe('triage');
    expect(bugBoard.roleForPhase('planning')).toBe('plan');
    expect(bugBoard.roleForPhase('tests')).toBe('tester');
    expect(bugBoard.phaseForRole('tester')).toBe('tests');
    expect(bugBoard.roleForPhase('execute')).toBe('work');
    expect(bugBoard.roleForPhase('review')).toBe('work');
    expect(bugBoard.isTerminal('done')).toBe(true);
    expect(bugBoard.isTerminal('canceled')).toBe(true);
    expect(bugBoard.allowsTransition('execute', 'intake')).toBe(true);
    expect(bugBoard.allowsTransition('triage', 'canceled')).toBe(true);
    expect(isBugBoardPhase('execute')).toBe(true);
    expect(isBugBoardPhase('toString')).toBe(false);
  });

  it("declares Work's change-request, classification, closure, and tool rules", () => {
    expect(bugBoard.changeRequests).toEqual(workBoard.changeRequests);
    expect(bugBoard.changeRequests).toEqual({ build: 'execute', review: 'review', merged: 'done' });
    expect(bugBoard.triageClassification).toBe(true);
    expect(bugBoard.reproductionTest).toEqual({ record: 'tests', protect: 'execute' });
    expect(bugBoard.sourceClosed).toEqual({ completed: 'done', canceled: 'canceled' });
    expect(Object.keys(bugBoard.tools).sort()).toEqual(['factory_record_review_verdict', 'submit_plan']);
    const boards = createBoardRegistry({ boards: [bugBoard] });
    expect(resolveBoardToolRule(boards, 'bug', 'submit_plan')).toBeTypeOf('function');
    expect(resolvePhaseSemantics(boards, 'bug', 'planning')).toEqual({ kind: 'working', role: 'plan' });
    expect(resolveBoardChangeRequests(boards, { board: 'bug', externalSource: null })).toEqual({
      boardTitle: 'Bug',
      build: { phase: 'execute', title: 'Fix' },
      review: { phase: 'review', title: 'Review' },
      merged: { phase: 'done', title: 'Done' },
      builderRole: 'work',
    });
  });
});

describe('bug board phase rules', () => {
  it('triages with bug-triage in the triage seat', async () => {
    const decision = await bugBoard.rules.triage?.issue?.onEnter?.(entry('triage', 'intake'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'triage', skillName: 'bug-triage' });
    expect(decision?.type === 'invokeSkill' && decision.arguments).toContain('GitHub issue #42');
    const gitlab = await bugBoard.rules.triage?.gitlabIssue?.onEnter?.(entry('triage', 'intake', { source: 'gitlab-issue' }));
    expect(gitlab?.type === 'invokeSkill' && gitlab.arguments).toContain('gitlab_get_issue');
    expect(bugBoard.rules.triage?.manual?.onEnter).toBeTypeOf('function');
  });

  it('plans with bug-plan in the plan seat', async () => {
    const decision = await bugBoard.rules.planning?.issue?.onEnter?.(entry('planning', 'triage'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'plan', skillName: 'bug-plan' });
  });

  it('writes the reproduction test with bug-test in its own tester seat', async () => {
    const decision = await bugBoard.rules.tests?.issue?.onEnter?.(entry('tests', 'planning'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'tester', skillName: 'bug-test' });
  });

  it('fixes with bug-build around the recorded test, always leaving through Review', async () => {
    const recorded = { bugReproTestSha: 'c'.repeat(40), bugReproTestPaths: ['app/test/profile_test.dart'] };
    const direct = await bugBoard.rules.execute?.issue?.onEnter?.(entry('execute', 'tests', { metadata: recorded }));
    expect(direct).toMatchObject({ type: 'invokeSkill', role: 'work', skillName: 'bug-build' });
    if (direct?.type !== 'invokeSkill') throw new Error('Expected a build invocation.');
    expect(direct.arguments).toContain(`committed at ${'c'.repeat(40)}`);
    expect(direct.arguments).toContain('"app/test/profile_test.dart"');
    expect(direct.arguments).toContain('Do not modify, move, or delete those files');
    expect(direct.arguments).toContain('Do not open a pull or merge request from Fix.');
    expect(direct.arguments).toContain('open the pull or merge request from Review');

    const selfReviewed = await bugBoard.rules.execute?.issue?.onEnter?.(
      entry('execute', 'tests', { selfReview: true, metadata: recorded }),
    );
    if (selfReviewed?.type !== 'invokeSkill') throw new Error('Expected a build invocation.');
    expect(selfReviewed.arguments).toContain('Do not open a pull or merge request.');
    expect(selfReviewed.arguments).toContain('An independent reviewer tests the branch there');
  });

  it('passes self-review findings back to the builder', async () => {
    const decision = await bugBoard.rules.execute?.issue?.onEnter?.(
      entry('execute', 'review', {
        selfReview: true,
        metadata: { selfReviewVerdict: 'request changes', selfReviewFindings: '1. The test passes without the fix' },
      }),
    );
    if (decision?.type !== 'invokeSkill') throw new Error('Expected a build invocation.');
    expect(decision.arguments).toContain('Self-review requested changes');
    expect(decision.arguments).toContain('1. The test passes without the fix');
  });

  it('self-reviews in the review seat only before a pull request exists', async () => {
    expect(await bugBoard.rules.review?.issue?.onEnter?.(entry('review', 'execute', { selfReview: true }))).toMatchObject({
      type: 'invokeSkill',
      role: 'review',
      skillName: 'factory-self-review',
    });
    expect(await bugBoard.rules.review?.issue?.onEnter?.(entry('review', 'execute'))).toBeUndefined();
    expect(
      await bugBoard.rules.review?.issue?.onEnter?.(
        entry('review', 'execute', { selfReview: true, metadata: { openPullRequestNumber: 7 } }),
      ),
    ).toBeUndefined();
  });

  it('marks the issue done on Done and leaves Canceled quiet', async () => {
    expect(await bugBoard.rules.done?.issue?.onEnter?.(entry('done', 'review'))).toMatchObject({
      skillName: 'factory-complete-issue',
    });
    expect(bugBoard.rules.canceled).toBeUndefined();
  });

  it('advances an approved interactive plan to the reproduction test on its own board', () => {
    const context = entry('planning', 'triage');
    expect(
      bugBoard.tools.submit_plan!.onResult({
        ...context,
        actor: { type: 'agent', bindingId: 'binding-1', role: 'plan' },
        toolName: 'submit_plan',
        threadId: 'thread-1',
        assistantMessageId: 'message-1',
        toolCallId: 'call-1',
        result: { status: 'success', value: 'Plan approved.' },
      }),
    ).toMatchObject({ type: 'transition', board: 'bug', stage: 'tests' });
  });
});
