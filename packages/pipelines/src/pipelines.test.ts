import { describe, expect, it } from 'vitest';
import {
  defineBoard,
  FACTORY_ROLE_STAGES,
  FACTORY_RULE_STAGES,
  isTerminalFactoryRuleStage,
  isWorkingFactoryRuleStage,
  resolveBoardClosure,
  resolveBoardToolRule,
  resolveFactoryStageRules,
  resolvePhaseSemantics,
  rulePhaseContext,
  workItemPhaseSemantics,
} from '@factory/core';

import { allowsBuiltInBoardTransition, createPipelines } from './index.ts';
import { reviewBoard } from './review/board.ts';
import { workBoard } from './work/board.ts';

describe('factory pipelines', () => {
  const installed = createPipelines();

  it('installs Work and Review', () => {
    expect([...installed.keys()]).toEqual(['work', 'review']);
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

  it('defines the Review lifecycle', () => {
    expect(reviewBoard.initialPhase).toBe('intake');
    expect(reviewBoard.allowsTransition('intake', 'review')).toBe(true);
    expect(reviewBoard.allowsTransition('review', 'done')).toBe(true);
    expect(reviewBoard.allowsTransition('review', 'canceled')).toBe(true);
    expect(reviewBoard.allowsTransition('review', 'intake')).toBe(true);
    expect(reviewBoard.allowsTransition('done', 'review')).toBe(true);
    expect(reviewBoard.allowsTransition('canceled', 'review')).toBe(true);
    expect(reviewBoard.rules.intake?.pullRequest?.onEnter).toBeUndefined();
    expect(reviewBoard.rules.review?.pullRequest?.onEnter).toBeTypeOf('function');
    expect(reviewBoard.roleForPhase('review')).toBe('review');
    expect(reviewBoard.isTerminal('done')).toBe(true);
    expect(reviewBoard.sourceClosed).toBeUndefined();
    expect(Object.keys(reviewBoard.tools)).toEqual([]);
  });

  it('defines the Work lifecycle', () => {
    expect(workBoard.initialPhase).toBe('intake');
    const phases = ['intake', 'triage', 'planning', 'execute', 'review', 'done', 'canceled'] as const;
    for (const from of phases) {
      for (const to of phases) {
        expect(workBoard.allowsTransition(from, to), `${from} -> ${to}`).toBe(true);
      }
    }
    expect(workBoard.rules.triage?.issue?.onEnter).toBeTypeOf('function');
    expect(workBoard.rules.planning?.manual?.onEnter).toBeTypeOf('function');
    expect(workBoard.roleForPhase('execute')).toBe('work');
    expect(workBoard.roleForPhase('review')).toBe('work');
    // The first phase of the `work` context; a run started on a resting Work card uses its role's lane instead.
    expect(workBoard.phaseForRole('work')).toBe('planning');
    expect(workBoard.tools.submit_plan?.onResult).toBeTypeOf('function');
    expect(workBoard.sourceClosed).toEqual({ completed: 'done', canceled: 'canceled' });
  });

  it('keeps Work and Review in agreement with the stage and role constants', () => {
    for (const stage of FACTORY_RULE_STAGES) {
      expect(workBoard.isTerminal(stage), `${stage} terminal`).toBe(isTerminalFactoryRuleStage([stage]));
      expect(workBoard.isWorking(stage), `${stage} working`).toBe(isWorkingFactoryRuleStage(stage));
    }
    for (const [role, stage] of Object.entries(FACTORY_ROLE_STAGES)) {
      const board = role === 'review' ? reviewBoard : workBoard;
      // Each role's lane is a working phase. Planning runs in the `work` context; `plan` stays
      // as the old role name for Planning's lane, so its phase reports the `work` context.
      expect(board.isWorking(stage), `lane for ${role}`).toBe(true);
    }
    expect(['triage', 'planning', 'execute', 'review'].map(stage => workBoard.roleForPhase(stage))).toEqual([
      'triage',
      'work',
      'work',
      'work',
    ]);
    expect(reviewBoard.roleForPhase('review')).toBe('review');
  });

  it('rejects inherited property names as Work and Review phases', () => {
    expect(allowsBuiltInBoardTransition('work', 'toString', 'done')).toBe(false);
    expect(allowsBuiltInBoardTransition('work', 'intake', 'constructor')).toBe(false);
    expect(allowsBuiltInBoardTransition('review', 'toString', 'done')).toBe(false);
    expect(allowsBuiltInBoardTransition('review', 'intake', 'constructor')).toBe(false);
  });

  it('resolves installed Work and Review entry handlers', () => {
    expect(
      resolveFactoryStageRules(installed, {
        board: 'work',
        source: 'issue',
        fromStage: 'intake',
        toStage: 'triage',
      }),
    ).toEqual([{ phase: 'enter', handler: workBoard.rules.triage?.issue?.onEnter }]);
    expect(
      resolveFactoryStageRules(installed, {
        board: 'review',
        source: 'pullRequest',
        fromStage: 'intake',
        toStage: 'review',
      }),
    ).toEqual([{ phase: 'enter', handler: reviewBoard.rules.review?.pullRequest?.onEnter }]);
  });

  it('reads Work phase semantics, tool rules, and closure from the installed registry', () => {
    expect(resolvePhaseSemantics(installed, 'work', 'planning')).toEqual({ kind: 'working', role: 'work' });
    expect(resolvePhaseSemantics(installed, 'work', 'done')).toEqual({ kind: 'terminal' });
    expect(resolveBoardToolRule(installed, 'work', 'submit_plan')).toBeTypeOf('function');
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
        stages: ['review'],
      }),
    ).toEqual({ kind: 'working', role: 'review' });
    expect(
      rulePhaseContext(installed, { board: null, externalSource: null, stages: ['execute'] }),
    ).toMatchObject({ kind: 'working', role: 'work' });
  });
});
