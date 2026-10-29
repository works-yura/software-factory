import { describe, expect, it } from 'vitest';

import { createBoardRegistry, resolveBoardChangeRequests, resolvePhaseSemantics } from '@factory/core';
import type { BoardTransitionPolicyContext, FactoryRuleItemContext, FactoryStageRuleContext } from '@factory/core';

import { createPipelines } from '../index.ts';
import { isWorkBoardPhase, workBoard } from './board.ts';
import { workTransitionPolicy } from './transition-policy.ts';

/**
 * Work's test-first path: bugs and feature requests pass through `tests`, where the tester commits
 * failing tests the builder may not touch. Other triage types go from Planning straight to Building.
 */

const RECORDED = { bugReproTestSha: 'c'.repeat(40), bugReproTestPaths: ['app/test/profile_test.dart'] };

function entry(
  stage: string,
  fromStage: string,
  overrides: {
    source?: FactoryRuleItemContext['source'];
    triageType?: FactoryRuleItemContext['triageType'];
    metadata?: Record<string, unknown>;
    selfReview?: boolean;
  } = {},
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
      triageType: overrides.triageType === undefined ? 'bug' : overrides.triageType,
      metadata: { githubIssueNumber: 42, identifier: 'acme/app#3', ...overrides.metadata },
    },
    board: 'work',
    itemRevision: 3,
    source: source === 'gitlab-issue' ? 'gitlabIssue' : 'issue',
    stage,
    fromStage,
    toStage: stage,
    ...(overrides.selfReview ? { selfReviewEnabled: true } : {}),
  };
}

function invocation(decision: unknown) {
  const value = decision as { type?: string; prompt?: string; arguments?: string } | undefined;
  if (value?.type !== 'invokeSkill') throw new Error('Expected a skill invocation.');
  return value.prompt ?? value.arguments ?? '';
}

function policy(
  fromStage: string,
  toStage: string,
  options: {
    role?: string;
    human?: boolean;
    requestedTriageType?: string;
    triageType?: string | null;
    plansAutoApproved?: boolean;
    planApproved?: boolean;
    acceptedAt?: Date | null;
    metadata?: Record<string, unknown>;
  } = {},
) {
  return workTransitionPolicy({
    actor: options.human ? { type: 'human', id: 'user-1' } : { type: 'agent', bindingId: 'b-1', role: options.role ?? 'work' },
    board: 'work',
    fromStage,
    toStage,
    isHumanTransition: options.human ?? false,
    plansAutoApproved: options.plansAutoApproved ?? false,
    planApproved: options.planApproved ?? false,
    requestedTriageType: options.requestedTriageType,
    item: {
      triageType: options.triageType === undefined ? 'bug' : options.triageType,
      acceptedAt: options.acceptedAt ?? null,
      metadata: options.metadata ?? {},
    },
  } as unknown as BoardTransitionPolicyContext);
}

describe('work board: test-first definition', () => {
  it('installs Work, Review, and Acceptance only', () => {
    expect([...createPipelines().keys()]).toEqual(['work', 'review', 'acceptance']);
  });

  it('puts the tests phase between Planning and Building in its own tester seat', () => {
    expect(Object.keys(workBoard.phases)).toEqual([
      'intake',
      'triage',
      'planning',
      'tests',
      'execute',
      'review',
      'done',
      'canceled',
    ]);
    expect(workBoard.roleForPhase('tests')).toBe('tester');
    expect(workBoard.phaseForRole('tester')).toBe('tests');
    expect(workBoard.roleForPhase('execute')).toBe('work');
    expect(workBoard.reproductionTest).toEqual({ record: 'tests', protect: 'execute' });
    expect(isWorkBoardPhase('tests')).toBe(true);
    const boards = createBoardRegistry({ boards: [workBoard] });
    expect(resolvePhaseSemantics(boards, 'work', 'tests')).toEqual({ kind: 'working', role: 'tester' });
    expect(resolveBoardChangeRequests(boards, { board: 'work', externalSource: null })).toMatchObject({
      build: { phase: 'execute', title: 'Building' },
      builderRole: 'work',
    });
  });
});

describe('work board: skills by triage type', () => {
  it('plans a bug with bug-plan and everything else with factory-plan', async () => {
    expect(await workBoard.rules.planning?.issue?.onEnter?.(entry('planning', 'triage'))).toMatchObject({
      role: 'plan',
      skillName: 'bug-plan',
    });
    for (const triageType of ['feature request', 'docs', null] as const) {
      expect(
        await workBoard.rules.planning?.issue?.onEnter?.(entry('planning', 'triage', { triageType })),
        String(triageType),
      ).toMatchObject({ role: 'plan', skillName: 'factory-plan' });
    }
    const gitlab = await workBoard.rules.planning?.gitlabIssue?.onEnter?.(entry('planning', 'triage', { source: 'gitlab-issue' }));
    expect(invocation(gitlab)).toContain('gitlab_get_issue');
  });

  it('writes a bug reproduction with bug-test and a feature test plan with factory-test, in the tester seat', async () => {
    expect(await workBoard.rules.tests?.issue?.onEnter?.(entry('tests', 'planning'))).toMatchObject({
      role: 'tester',
      skillName: 'bug-test',
    });
    expect(
      await workBoard.rules.tests?.issue?.onEnter?.(entry('tests', 'planning', { triageType: 'feature request' })),
    ).toMatchObject({ role: 'tester', skillName: 'factory-test' });
    expect(workBoard.rules.tests?.manual?.onEnter).toBeTypeOf('function');
  });

  it('builds a bug with bug-build around the recorded test, always leaving through Review', async () => {
    const direct = await workBoard.rules.execute?.issue?.onEnter?.(entry('execute', 'tests', { metadata: RECORDED }));
    expect(direct).toMatchObject({ role: 'work', skillName: 'bug-build' });
    const text = invocation(direct);
    expect(text).toContain(`committed at ${'c'.repeat(40)}`);
    expect(text).toContain('"app/test/profile_test.dart"');
    expect(text).toContain('Do not modify, move, or delete those files');
    expect(text).toContain('Do not open a pull or merge request from Building.');
    expect(text).toContain('open the pull or merge request from Review');

    const selfReviewed = await workBoard.rules.execute?.issue?.onEnter?.(
      entry('execute', 'tests', { selfReview: true, metadata: RECORDED }),
    );
    expect(invocation(selfReviewed)).toContain('An independent reviewer tests the branch there');
  });

  it('builds a feature around its recorded tests with the plain build prompt', async () => {
    const decision = await workBoard.rules.execute?.issue?.onEnter?.(
      entry('execute', 'tests', { triageType: 'feature request', metadata: RECORDED }),
    );
    expect(decision).toMatchObject({ role: 'work' });
    expect(decision).not.toHaveProperty('skillName');
    const text = invocation(decision);
    expect(text).toContain('The recorded tests fail on the current code.');
    expect(text).toContain('Do not modify, move, or delete those files');
  });

  it('leaves a build without recorded tests as it was', async () => {
    const decision = await workBoard.rules.execute?.issue?.onEnter?.(entry('execute', 'planning', { triageType: 'docs' }));
    const text = invocation(decision);
    expect(text).toContain('Implement the approved plan for the work item.');
    expect(text).toContain('Open a pull request when the work is ready for review.');
    expect(text).not.toContain('committed at');
  });

  it('advances an approved interactive plan to tests for test-first types and to Building otherwise', () => {
    const approve = (triageType: FactoryRuleItemContext['triageType']) => {
      const context = entry('planning', 'triage', { triageType });
      return workBoard.tools.submit_plan!.onResult({
        ...context,
        actor: { type: 'agent', bindingId: 'binding-1', role: 'plan' },
        toolName: 'submit_plan',
        threadId: 'thread-1',
        assistantMessageId: 'message-1',
        toolCallId: 'call-1',
        result: { status: 'success', value: 'Plan approved.' },
      });
    };
    expect(approve('bug')).toMatchObject({ type: 'transition', board: 'work', stage: 'tests' });
    expect(approve('feature request')).toMatchObject({ type: 'transition', stage: 'tests' });
    expect(approve('docs')).toMatchObject({ type: 'transition', stage: 'execute' });
    expect(approve(null)).toMatchObject({ type: 'transition', stage: 'execute' });
  });
});

describe('work board: test-first transition policy', () => {
  it('gates entering tests on an approved plan, as Building is gated', () => {
    expect(policy('planning', 'tests', { role: 'plan' })).toMatchObject({ type: 'reject', code: 'approval_required' });
    expect(policy('planning', 'tests', { role: 'plan', planApproved: true })).toMatchObject({ type: 'allow' });
    expect(policy('planning', 'tests', { role: 'plan', plansAutoApproved: true })).toMatchObject({ type: 'allow' });
    expect(policy('planning', 'tests', { human: true })).toMatchObject({ type: 'allow' });
    expect(policy('triage', 'tests', { role: 'triage', requestedTriageType: 'bug' })).toMatchObject({
      type: 'reject',
      code: 'approval_required',
    });
  });

  it('still needs a person before a non-bug enters tests', () => {
    const feature = { role: 'plan', triageType: 'feature request', plansAutoApproved: true } as const;
    expect(policy('planning', 'tests', feature)).toMatchObject({ type: 'reject', code: 'approval_required' });
    expect(policy('planning', 'tests', { ...feature, acceptedAt: new Date() })).toMatchObject({ type: 'allow' });
  });

  it('lets an agent reach Building on a bug or feature only from recorded tests, or back from Review', () => {
    for (const triageType of ['bug', 'feature request'] as const) {
      const accepted = { triageType, plansAutoApproved: true, acceptedAt: new Date() };
      for (const fromStage of ['planning', 'triage', 'intake']) {
        expect(policy(fromStage, 'execute', { role: 'plan', ...accepted }), `${triageType} ${fromStage}`).toMatchObject({
          type: 'reject',
          code: 'invalid_transition',
        });
      }
      expect(policy('tests', 'execute', { role: 'tester', ...accepted })).toMatchObject({
        type: 'reject',
        reason: expect.stringContaining('No failing test is recorded'),
      });
      expect(policy('tests', 'execute', { role: 'tester', ...accepted, metadata: RECORDED })).toMatchObject({
        type: 'allow',
      });
      expect(policy('review', 'execute', { role: 'review', ...accepted })).toMatchObject({ type: 'allow' });
      expect(policy('planning', 'execute', { human: true, triageType })).toMatchObject({ type: 'allow' });
    }
  });

  it('lets other types go from Planning straight to Building', () => {
    for (const triageType of ['docs', 'maintenance', null]) {
      expect(
        policy('planning', 'execute', { role: 'plan', triageType, plansAutoApproved: true, acceptedAt: new Date() }),
        String(triageType),
      ).toMatchObject({ type: 'allow' });
    }
  });

  it('answers a card parked for a person before asking for tests', () => {
    const parked = { selfReviewVerdict: 'request changes', selfReviewNeedsHuman: true };
    expect(policy('intake', 'execute', { metadata: parked })).toMatchObject({ code: 'approval_required' });
  });

  it('lets the tester or builder park a card that cannot be tested in Intake', () => {
    expect(policy('tests', 'intake', { role: 'tester' })).toMatchObject({ type: 'allow' });
    expect(policy('execute', 'intake')).toMatchObject({ type: 'allow' });
  });

  it("keeps Work's Done guards for test-first cards", () => {
    expect(policy('review', 'done', { metadata: { openPullRequestNumber: 17 } })).toMatchObject({ type: 'reject' });
    expect(policy('review', 'done', { metadata: { reviewVerdict: 'request changes' } })).toMatchObject({ type: 'reject' });
    expect(policy('review', 'done', { human: true, metadata: { openPullRequestNumber: 17 } })).toMatchObject({
      type: 'allow',
    });
  });
});
