import { defineBoard } from '@factory/core';
import type { BoardDefinition, BoardRegistry, ProviderWorkItem } from '@factory/core';

export { createTestBoard } from '@factory/core/testing';

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
  return new Map<string, BoardDefinition<string, string>>([[board.id, board]]);
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
