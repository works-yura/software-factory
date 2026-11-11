import { defineBoard } from '@factory/core';
import type { BoardPhaseDefinition, RuleGroup } from '@factory/core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { workBoard } from './work/board.ts';
import type { WorkBoardPhase } from './work/board.ts';

const LOW_EFFORT: RuleGroup = {
  operator: 'AND',
  conditions: [{ field: 'item.labels', operator: 'contains', value: 'effort:low' }],
};

describe('built-in board phase fields', () => {
  it('keeps the built-in Work board contexts: Planning shares the `work` session with Building', () => {
    expect(workBoard.phases.planning).toMatchObject({ name: 'Planning', runner: { context: 'work' } });
    expect(workBoard.phases.intake.nextPhases).toEqual(workBoard.transitions.intake.map(({ to }) => to));
  });

  it('accepts a defined board phase back as a declaration, as fixtures that extend a board do', () => {
    const copy = defineBoard({ id: 'copy', name: 'Copy', initialPhase: 'intake', phases: workBoard.phases });
    expect(copy.transitions).toEqual(workBoard.transitions);
    expect(copy.phases['pr-review']).toMatchObject({
      kind: 'working',
      runner: { context: 'review' },
      tools: ['factory_record_review_verdict', 'factory_review_source'],
    });
    expect(copy.phases['pr-review']).toMatchObject({ role: 'review' });
  });

  it('lets a board that keeps the built-in Work tool rules end Planning with submit_plan', () => {
    const board = defineBoard({
      id: 'work-plus',
      name: 'Work plus',
      initialPhase: 'intake',
      tools: workBoard.tools,
      phases: {
        ...workBoard.phases,
        planning: {
          ...workBoard.phases.planning,
          exitTool: { id: 'submit_plan', autoApprove: true, autoApproveWhen: LOW_EFFORT },
        } as BoardPhaseDefinition<WorkBoardPhase>,
      },
    });
    expect(board.tools).toEqual(workBoard.tools);
    expect(board.phases.planning).toMatchObject({ exitTool: { id: 'submit_plan', autoApprove: true } });
  });

  it('stays quiet for new fields, built-in boards and defined phases declared again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());

    defineBoard({
      id: 'current-release',
      name: 'Release',
      initialPhase: 'backlog',
      phases: {
        backlog: { name: 'Backlog', kind: 'resting', nextPhases: ['build'] },
        build: {
          name: 'Build',
          kind: 'working',
          runner: { context: 'publisher', skill: 'publish', goal: { objective: 'The release is published.' } },
          nextPhases: ['done'],
        },
        done: { name: 'Done', kind: 'terminal' },
      },
    });
    defineBoard({ id: 'work-again', name: 'Work', initialPhase: 'intake', phases: workBoard.phases });

    expect(warn).not.toHaveBeenCalled();
  });

  it('defines the built-in boards without deprecated fields', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    vi.resetModules();

    await import('./work/board.ts');

    expect(warn).not.toHaveBeenCalled();
  });
});
