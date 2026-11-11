import { describe, expect, it } from 'vitest';
import {
  boardFlow,
  defineBoard,
  resolveBoardClosure,
  resolveBoardToolRule,
  phaseRunDecision,
  resolvePhaseSemantics,
  rulePhaseContext,
  workItemPhaseSemantics,
} from '@factory/core';

import { createPipelines } from './index.ts';
import { workBoard } from './work/board.ts';
import type { WorkBoardPhase } from './work/board.ts';

describe('factory pipelines', () => {
  const installed = createPipelines();

  it('installs Work only: the Review board was retired', () => {
    expect([...installed.keys()]).toEqual(['work']);
  });

  it('rejects a second pipeline with a reserved id', () => {
    const replacement = defineBoard({
      id: 'work',
      title: 'Replacement',
      initialPhase: 'start',
      phases: { start: { title: 'Start', kind: 'resting' } },
    });
    expect(() => createPipelines([replacement])).toThrow("duplicate board id 'work'");
  });

  it('defines the Work lifecycle', () => {
    expect(workBoard.initialPhase).toBe('intake');
    // Each phase names where a card goes next (upstream #29039); the board no longer allows every move.
    const flow: Record<WorkBoardPhase, string[]> = {
      intake: ['triage', 'planning', 'pr-review', 'done', 'canceled'],
      triage: ['intake', 'planning', 'done', 'canceled'],
      planning: ['execute', 'triage', 'intake', 'done', 'canceled'],
      // PR review once the builder opened the change request with self-review off (upstream #29707).
      execute: ['review', 'pr-review', 'planning', 'done', 'canceled'],
      // A maintainer's review request takes the card's open pull request to PR review (upstream #29346).
      review: ['execute', 'intake', 'pr-review', 'done', 'canceled'],
      // An issue card can go back to its builder for a fix; a pull request's own card can't (Work's policy).
      'pr-review': ['intake', 'planning', 'execute', 'done', 'canceled'],
      done: ['pr-review'],
      canceled: ['intake', 'pr-review'],
    };
    for (const from of Object.keys(flow) as WorkBoardPhase[]) {
      for (const to of Object.keys(flow) as WorkBoardPhase[]) {
        // Staying put is always allowed.
        expect(workBoard.allowsTransition(from, to), `${from} -> ${to}`).toBe(from === to || flow[from].includes(to));
      }
    }
    // Each working phase starts its stored runner's skill, for every source; Intake and Done run nothing.
    const skills = Object.fromEntries(
      Object.entries(workBoard.phases).map(([key, phase]) => [key, phase.kind === 'working' ? phase.runner.skill : null]),
    );
    expect(skills).toEqual({
      intake: null,
      triage: 'factory-triage',
      planning: 'factory-plan',
      execute: 'factory-build',
      review: 'factory-self-review',
      'pr-review': 'factory-review',
      done: null,
      canceled: null,
    });
    expect(workBoard.phases.execute).toMatchObject({ runner: { goal: { maxRuns: 20 } } });
    // Planning holds the card until its exit tool approves the plan; Work declares no tool rules.
    expect(workBoard.phases.planning).toMatchObject({ exitTool: { id: 'submit_plan', autoApprove: false } });
    expect(workBoard.tools).toEqual({});
    // The independent reviewer works the card in Review and PR review, with the phase tools it needs.
    expect(workBoard.phases.review).toMatchObject({ tools: ['factory_record_review_verdict'], autoStart: true });
    expect(workBoard.phases['pr-review']).toMatchObject({
      tools: ['factory_record_review_verdict', 'factory_review_source'],
    });
    expect(workBoard.roleForPhase('execute')).toBe('work');
    expect(workBoard.roleForPhase('review')).toBe('review');
    expect(workBoard.roleForPhase('pr-review')).toBe('review');
    // The first phase of the `work` context; a run started on a resting Work card uses its role's lane instead.
    expect(workBoard.phaseForRole('work')).toBe('planning');
    expect(workBoard.sourceClosed).toEqual({ completed: 'done', canceled: 'canceled' });
  });

  it('reads each part of the pull request loop from Work\'s phases', () => {
    expect(boardFlow(workBoard)).toEqual({
      initialPhase: 'intake',
      completed: { phase: 'done', title: 'Done' },
      canceled: { phase: 'canceled', title: 'Canceled' },
      triage: 'triage',
      pullRequestReview: 'pr-review',
      selfReview: 'review',
      build: 'execute',
      buildRole: 'work',
    });
    expect(['triage', 'planning', 'execute', 'review'].map(stage => workBoard.roleForPhase(stage))).toEqual([
      'triage',
      'work',
      'work',
      'review',
    ]);
  });

  it('rejects inherited property names as Work phases', () => {
    expect(workBoard.allowsTransition('toString' as never, 'done')).toBe(false);
    expect(workBoard.allowsTransition('intake', 'constructor' as never)).toBe(false);
  });

  it('starts each Work phase from its stored runner, whatever the card came from', () => {
    const rule = (fromStage: string) => ({
      ingress: { id: 'ingress-1' } as never,
      item: { url: 'https://github.test/acme/repo/issues/7', title: 'Fix it', source: 'github-issue', metadata: null } as never,
      fromStage,
    });
    expect(phaseRunDecision(workBoard, 'triage', rule('intake'))).toEqual({
      type: 'invokeSkill',
      idempotencyKey: 'ingress-1:triage:factory-triage',
      role: 'triage',
      skillName: 'factory-triage',
      arguments: 'Work item (https://github.test/acme/repo/issues/7)',
      startsAfterOwnMove: true,
    });
    expect(phaseRunDecision(workBoard, 'execute', rule('planning'))).toMatchObject({
      skillName: 'factory-build',
      role: 'work',
      goal: { maxRuns: 20 },
    });
    expect(phaseRunDecision(workBoard, 'pr-review', rule('intake'))).toMatchObject({
      skillName: 'factory-review',
      role: 'review',
    });
    // Intake, Done and Canceled run nothing.
    expect(phaseRunDecision(workBoard, 'done', rule('pr-review'))).toBeUndefined();
  });

  it('reads Work phase semantics, tool rules, and closure from the installed registry', () => {
    expect(resolvePhaseSemantics(installed, 'work', 'planning')).toEqual({ kind: 'working', role: 'work' });
    expect(resolvePhaseSemantics(installed, 'work', 'done')).toEqual({ kind: 'terminal' });
    expect(resolveBoardToolRule(installed, 'work', 'submit_plan')).toBeUndefined();
    expect(resolveBoardClosure(installed, { board: 'work', externalSource: null, stages: ['canceled'] })).toEqual({
      boardTitle: 'Work',
      completed: { phase: 'done', title: 'Done' },
      canceled: { phase: 'canceled', title: 'Canceled' },
      itemTerminal: true,
    });
    expect(
      workItemPhaseSemantics(installed, {
        board: null,
        externalSource: { integrationId: 'github', type: 'pull-request', externalId: '1' },
        stages: ['pr-review'],
      }),
    ).toEqual({ kind: 'working', role: 'review' });
    expect(
      rulePhaseContext(installed, { board: null, externalSource: null, stages: ['execute'] }),
    ).toMatchObject({ kind: 'working', role: 'work' });
  });
});
