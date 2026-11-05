import { defineBoard } from '@factory/core';
import type { BoardDefinition, BoardRegistry } from '@factory/core';

export { createTestBoard } from '@factory/core/testing';

import { reviewBoard } from './review/board.ts';
import { workBoard } from './work/board.ts';

// Unit tests inject a registry directly to exercise Work-specific runtime policies.
// Production installation still reserves built-in IDs and has no override API.
export function createLifecycleTestRegistry(handlers: BoardDefinition<string, string>['rules']): BoardRegistry {
  const board = defineBoard({
    id: 'work',
    name: 'Work lifecycle fixture',
    initialPhase: 'intake',
    sourceClosed: workBoard.sourceClosed,
    changeRequests: workBoard.changeRequests,
    triageClassification: workBoard.triageClassification,
    phases: Object.fromEntries(
      Object.entries(workBoard.phases).map(([stage, phase]) => {
        const leaves = Object.entries(handlers[stage] ?? {});
        return [
          stage,
          {
            ...phase,
            // Lifecycle tests jump straight to the phase whose handlers they exercise; the
            // Work board's own topology is tested against workBoard itself.
            nextPhases: Object.keys(workBoard.phases).filter(other => other !== stage),
            onEnter: {
              ...phase.onEnter,
              ...Object.fromEntries(
                leaves.filter(([, leaf]) => leaf && 'onEnter' in leaf).map(([source, leaf]) => [source, leaf?.onEnter]),
              ),
            },
            onExit: {
              ...phase.onExit,
              ...Object.fromEntries(
                leaves.filter(([, leaf]) => leaf && 'onExit' in leaf).map(([source, leaf]) => [source, leaf?.onExit]),
              ),
            },
          },
        ];
      }),
    ),
  });
  return new Map<string, BoardDefinition<string, string>>([
    [board.id, board],
    [reviewBoard.id, reviewBoard],
  ]);
}

/** Work board with its tool-result rules replaced, for exercising the processor's tool ingress. */
export function createToolRuleTestRegistry(tools: BoardDefinition<string, string>['tools']): BoardRegistry {
  const board = defineBoard({
    id: 'work',
    name: 'Work tool-rule fixture',
    initialPhase: 'intake',
    phases: workBoard.phases,
    transitionPolicy: workBoard.transitionPolicy,
    sourceClosed: workBoard.sourceClosed,
    changeRequests: workBoard.changeRequests,
    triageClassification: workBoard.triageClassification,
    tools: { ...tools },
  });
  return new Map<string, BoardDefinition<string, string>>([
    [board.id, board],
    [reviewBoard.id, reviewBoard],
  ]);
}

