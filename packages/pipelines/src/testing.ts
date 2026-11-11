import { defineBoard } from '@factory/core';
import type {
  BoardDefinition,
  BoardPhaseDefinition,
  BoardPhaseRunner,
  BoardRegistry,
  BoardTransitionPolicy,
  ProviderWorkItem,
} from '@factory/core';

export { createTestBoard } from '@factory/core/testing';

import { workBoard } from './work/board.ts';
import type { WorkBoardPhase } from './work/board.ts';

// Unit tests inject a registry directly to exercise Work-specific runtime policies.
// Production installation still reserves built-in IDs and has no override API.
/** The lifecycle registry's Work board with a board policy standing in for the rules a move is evaluated against. */
export function createPolicyTestRegistry(transitionPolicy: BoardTransitionPolicy): BoardRegistry {
  const lifecycle = createLifecycleTestRegistry().get('work')!;
  const board = defineBoard({
    id: 'work',
    name: 'Work',
    initialPhase: 'intake',
    phases: lifecycle.phases as unknown as Record<string, BoardPhaseDefinition<string>>,
    transitionPolicy,
  });
  return new Map([[board.id, board]]);
}

/**
 * Work with every phase allowed to move to every other, and the given phases' stored fields
 * overridden (a runner, …). Lifecycle tests jump straight to the phase they
 * exercise; the Work board's own topology is tested against workBoard itself.
 */
export function createLifecycleTestRegistry(
  overrides: Partial<Record<WorkBoardPhase, { runner?: BoardPhaseRunner }>> = {},
): BoardRegistry {
  const board = defineBoard({
    id: 'work',
    name: 'Work lifecycle fixture',
    initialPhase: 'intake',
    sourceClosed: workBoard.sourceClosed,
    triageClassification: workBoard.triageClassification,
    phases: Object.fromEntries(
      Object.entries(workBoard.phases).map(([stage, phase]) => [
        stage,
        {
          ...phase,
          nextPhases: Object.keys(workBoard.phases).filter(other => other !== stage),
          ...overrides[stage as WorkBoardPhase],
        } as BoardPhaseDefinition<string>,
      ]),
    ),
  });
  return new Map<string, BoardDefinition<string, string>>([[board.id, board]]);
}

/** Work board with the given tool-result rules, for exercising the processor's tool ingress. */
export function createToolRuleTestRegistry(tools: BoardDefinition<string, string>['tools']): BoardRegistry {
  const board = defineBoard({
    id: 'work',
    name: 'Work tool-rule fixture',
    initialPhase: 'intake',
    phases: workBoard.phases,
    transitionPolicy: workBoard.transitionPolicy,
    sourceClosed: workBoard.sourceClosed,
    triageClassification: workBoard.triageClassification,
    tools: { ...tools },
  });
  return new Map<string, BoardDefinition<string, string>>([[board.id, board]]);
}


/** A provider work item for rule-context fixtures: the facts a card's source holds apart from board metadata. */
export function providerWorkItemForTests(
  input: Partial<Pick<ProviderWorkItem, 'provider' | 'key' | 'url' | 'state' | 'labels' | 'author' | 'metadata'>> = {},
): ProviderWorkItem {
  return {
    sources: [],
    id: 'work-item-1',
    orgId: 'org-1',
    factoryProjectId: 'project-1',
    provider: input.provider ?? 'github',
    externalId: 'external-1',
    key: input.key ?? null,
    url: input.url ?? null,
    title: 'Work item',
    state: input.state ?? null,
    labels: input.labels ?? [],
    author: input.author ?? null,
    parentWorkItemId: null,
    metadata: input.metadata ?? null,
    revision: 1,
    syncedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
