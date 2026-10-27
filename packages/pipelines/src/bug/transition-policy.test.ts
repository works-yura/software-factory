import { describe, expect, it } from 'vitest';

import type { BoardTransitionPolicyContext } from '@factory/core';
import { bugTransitionPolicy } from './transition-policy.ts';

function context(
  fromStage: string,
  toStage: string,
  options: {
    role?: string;
    human?: boolean;
    requestedTriageType?: string;
    triageType?: string | null;
    plansAutoApproved?: boolean;
    planApproved?: boolean;
    metadata?: Record<string, unknown>;
  } = {},
): BoardTransitionPolicyContext {
  return {
    actor: options.human ? { type: 'human', id: 'user-1' } : { type: 'agent', bindingId: 'b-1', role: options.role ?? 'work' },
    board: 'bug',
    fromStage,
    toStage,
    isHumanTransition: options.human ?? false,
    plansAutoApproved: options.plansAutoApproved ?? false,
    planApproved: options.planApproved ?? false,
    requestedTriageType: options.requestedTriageType,
    item: { triageType: options.triageType ?? null, acceptedAt: null, metadata: options.metadata ?? {} },
  } as unknown as BoardTransitionPolicyContext;
}

describe('bug transition policy', () => {
  it('requires the triage agent to classify, and records a bug classification on the way to Planning', () => {
    expect(bugTransitionPolicy(context('triage', 'planning', { role: 'triage' }))).toMatchObject({
      type: 'reject',
      code: 'invalid_transition',
    });
    expect(
      bugTransitionPolicy(context('triage', 'planning', { role: 'triage', requestedTriageType: 'bug' })),
    ).toEqual({ type: 'allow', triageType: 'bug' });
  });

  it('closes a non-bug on this board instead of carrying it on', () => {
    for (const toStage of ['planning', 'execute', 'done', 'triage']) {
      const rejected = bugTransitionPolicy(
        context('triage', toStage, { role: 'triage', requestedTriageType: 'feature request' }),
      );
      expect(rejected, toStage).toMatchObject({
        type: 'reject',
        code: 'invalid_transition',
        reason: expect.stringContaining('Cards cannot change boards'),
      });
    }
    expect(
      bugTransitionPolicy(context('triage', 'canceled', { role: 'triage', requestedTriageType: 'feature request' })),
    ).toEqual({ type: 'allow', triageType: 'feature request' });
    expect(
      bugTransitionPolicy(context('triage', 'intake', { role: 'triage', requestedTriageType: 'question/support' })),
    ).toMatchObject({ type: 'allow' });
  });

  it('keeps a later agent from carrying a classified non-bug into Planning without a person', () => {
    expect(
      bugTransitionPolicy(context('intake', 'planning', { role: 'plan', triageType: 'feature request' })),
    ).toMatchObject({ type: 'reject', code: 'approval_required' });
    expect(
      bugTransitionPolicy(context('intake', 'planning', { human: true, triageType: 'feature request' })),
    ).toMatchObject({ type: 'allow', accept: true });
  });

  it('gates the reproduction test on an approved plan unless the Factory auto-approves plans', () => {
    expect(bugTransitionPolicy(context('planning', 'tests', { role: 'plan', triageType: 'bug' }))).toMatchObject({
      type: 'reject',
      code: 'approval_required',
    });
    expect(
      bugTransitionPolicy(context('planning', 'tests', { role: 'plan', triageType: 'bug', planApproved: true })),
    ).toMatchObject({ type: 'allow' });
    expect(
      bugTransitionPolicy(context('planning', 'tests', { role: 'plan', triageType: 'bug', plansAutoApproved: true })),
    ).toMatchObject({ type: 'allow' });
    expect(bugTransitionPolicy(context('planning', 'tests', { human: true, triageType: 'bug' }))).toMatchObject({
      type: 'allow',
    });
    expect(bugTransitionPolicy(context('triage', 'tests', { role: 'triage', requestedTriageType: 'bug' }))).toMatchObject({
      type: 'reject',
      code: 'approval_required',
    });
  });

  it('lets an agent reach Fix only from a recorded reproduction test or back from Review', () => {
    for (const fromStage of ['planning', 'triage', 'intake']) {
      expect(
        bugTransitionPolicy(context(fromStage, 'execute', { role: 'plan', triageType: 'bug', plansAutoApproved: true })),
        fromStage,
      ).toMatchObject({ type: 'reject', code: 'invalid_transition' });
    }
    expect(bugTransitionPolicy(context('tests', 'execute', { role: 'tester', triageType: 'bug' }))).toMatchObject({
      type: 'reject',
      reason: expect.stringContaining('No reproduction test is recorded'),
    });
    expect(
      bugTransitionPolicy(
        context('tests', 'execute', { role: 'tester', triageType: 'bug', metadata: { bugReproTestSha: 'c'.repeat(40) } }),
      ),
    ).toMatchObject({ type: 'allow' });
    expect(bugTransitionPolicy(context('review', 'execute', { role: 'review', triageType: 'bug' }))).toMatchObject({
      type: 'allow',
    });
    expect(bugTransitionPolicy(context('planning', 'execute', { human: true, triageType: 'bug' }))).toMatchObject({
      type: 'allow',
    });
  });

  it('lets the tester park an unreproduced bug in Intake', () => {
    expect(bugTransitionPolicy(context('tests', 'intake', { role: 'tester', triageType: 'bug' }))).toMatchObject({
      type: 'allow',
    });
  });

  it('lets the builder park an unreproduced bug in Intake', () => {
    expect(bugTransitionPolicy(context('execute', 'intake', { triageType: 'bug' }))).toMatchObject({ type: 'allow' });
  });

  it("keeps Work's Done guards: open pull request, requested changes, pending self-review", () => {
    expect(
      bugTransitionPolicy(context('review', 'done', { triageType: 'bug', metadata: { openPullRequestNumber: 17 } })),
    ).toMatchObject({ type: 'reject', code: 'invalid_transition' });
    expect(
      bugTransitionPolicy(context('review', 'done', { triageType: 'bug', metadata: { reviewVerdict: 'request changes' } })),
    ).toMatchObject({ type: 'reject', code: 'invalid_transition' });
    expect(bugTransitionPolicy(context('review', 'done', { triageType: 'bug' }))).toMatchObject({ type: 'reject' });
    expect(
      bugTransitionPolicy(context('review', 'done', { human: true, triageType: 'bug', metadata: { openPullRequestNumber: 17 } })),
    ).toMatchObject({ type: 'allow' });
  });
});
