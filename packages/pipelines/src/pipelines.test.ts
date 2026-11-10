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
      execute: ['review', 'planning', 'done', 'canceled'],
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
    expect(workBoard.phases.planning).toMatchObject({ exitTool: { id: 'submit_plan', autoApprove: false } });
    expect(workBoard.rules.triage?.issue?.onEnter).toBeTypeOf('function');
    expect(workBoard.rules.planning?.manual?.onEnter).toBeTypeOf('function');
    expect(workBoard.roleForPhase('execute')).toBe('work');
    expect(workBoard.roleForPhase('review')).toBe('work');
    // The first phase of the `work` context; a run started on a resting Work card uses its role's lane instead.
    expect(workBoard.phaseForRole('work')).toBe('planning');
    expect(workBoard.tools.submit_plan?.onResult).toBeTypeOf('function');
    expect(workBoard.sourceClosed).toEqual({ completed: 'done', canceled: 'canceled' });
  });

  it('keeps Work in agreement with the stage and role constants', () => {
    for (const stage of FACTORY_RULE_STAGES) {
      expect(workBoard.isTerminal(stage), `${stage} terminal`).toBe(isTerminalFactoryRuleStage([stage]));
      expect(workBoard.isWorking(stage), `${stage} working`).toBe(isWorkingFactoryRuleStage(stage));
    }
    for (const [role, stage] of Object.entries(FACTORY_ROLE_STAGES)) {
      // Each role's lane is a working phase. Planning runs in the `work` context; `plan` stays
      // as the old role name for Planning's lane, so its phase reports the `work` context.
      expect(workBoard.isWorking(stage), `lane for ${role}`).toBe(true);
    }
    expect(['triage', 'planning', 'execute', 'review'].map(stage => workBoard.roleForPhase(stage))).toEqual([
      'triage',
      'work',
      'work',
      'work',
    ]);
  });

  it('rejects inherited property names as Work phases', () => {
    expect(allowsBuiltInBoardTransition('work', 'toString', 'done')).toBe(false);
    expect(allowsBuiltInBoardTransition('work', 'intake', 'constructor')).toBe(false);
  });

  it('resolves installed Work entry handlers, the pull request review included', () => {
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
        board: 'work',
        source: 'pullRequest',
        fromStage: 'intake',
        toStage: 'pr-review',
      }),
    ).toEqual([{ phase: 'enter', handler: workBoard.rules['pr-review']?.pullRequest?.onEnter }]);
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
        stages: ['pr-review'],
      }),
    ).toEqual({ kind: 'working', role: 'work' });
    expect(
      rulePhaseContext(installed, { board: null, externalSource: null, stages: ['execute'] }),
    ).toMatchObject({ kind: 'working', role: 'work' });
  });
});
