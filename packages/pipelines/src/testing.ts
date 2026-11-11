import { codeBoardOf, compileBoardDefinition, createBoardRegistry, declarationOf, defineBoard } from '@factory/core';
import type {
  BoardDefinition,
  BoardPhaseDefinition,
  BoardPhaseRunner,
  BoardRegistry,
  BoardTransitionPolicy,
  InstalledBoard,
  ProviderWorkItem,
} from '@factory/core';

export { createTestBoard } from '@factory/core/testing';

import { defaultBoards } from './defaults.ts';
import { workBoard } from './work/board.ts';
import { selfReviewWorkBoard } from './work/legacy-self-review.ts';
import { triageWorkBoard } from './work/legacy-triage.ts';

export { selfReviewWorkBoard, triageWorkBoard };

/**
 * The default boards as most projects store them: Work with its Triage phase ({@link triageWorkBoard}),
 * which new projects' Work dropped (upstream #29901), then `boards`. Suites written against Work's
 * Triage run on this; tests of today's Work use `createDefaultBoardRegistry()` from `@factory/pipelines`.
 */
export function createTriageWorkRegistry(
  options: { boards?: readonly InstalledBoard[]; includeDefaultBoards?: boolean } = {},
): BoardRegistry {
  const defaults = defaultBoards.map(board => (board === workBoard ? triageWorkBoard : board));
  return createBoardRegistry({
    boards: [...(options.includeDefaultBoards === false ? [] : defaults), ...(options.boards ?? [])],
  });
}

/** `createPipelines()` with Work as most projects store it (with Triage). */
export function createTriagePipelines(boards: readonly InstalledBoard[] = []): BoardRegistry {
  return createBoardRegistry({ boards: [triageWorkBoard, ...boards] });
}

/**
 * `boards` with every working phase starting on its own for every card: what the
 * `auto-run-switch-v1` board migration gives a project that had the retired auto-run switch on.
 */
export function autoStartingBoards(boards: BoardRegistry = createTriageWorkRegistry()): BoardRegistry {
  return new Map(
    [...boards.values()].map(board => {
      const config = declarationOf(board);
      if (!config) throw new Error(`Board '${board.id}' has no declaration to rebuild with autoStart.`);
      const phases = Object.fromEntries(
        Object.entries(config.phases as Record<string, BoardPhaseDefinition<string>>).map(([key, phase]) => {
          if (phase.kind !== 'working') return [key, phase];
          const { autoStartWhen: _when, ...rest } = phase;
          return [key, { ...rest, autoStart: true }];
        }),
      );
      return [board.id, compileBoardDefinition({ ...config, phases } as never, codeBoardOf(board))] as const;
    }),
  );
}

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
 * Work (with its self-review phase, {@link selfReviewWorkBoard}) with every phase allowed to
 * move to every other, and the given phases' stored fields overridden (a runner, …). Lifecycle
 * tests jump straight to the phase they exercise; the Work board's own topology is tested against
 * workBoard itself.
 */
export function createLifecycleTestRegistry(
  overrides: Partial<Record<string, { runner?: BoardPhaseRunner }>> = {},
): BoardRegistry {
  const lifecyclePhases = selfReviewWorkBoard.phases;
  const board = defineBoard({
    id: 'work',
    name: 'Work lifecycle fixture',
    initialPhase: 'intake',
    sourceClosed: workBoard.sourceClosed,
    triageClassification: workBoard.triageClassification,
    phases: Object.fromEntries(
      Object.entries(lifecyclePhases).map(([stage, phase]) => [
        stage,
        {
          ...phase,
          nextPhases: Object.keys(lifecyclePhases).filter(other => other !== stage),
          ...overrides[stage],
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
    // With the older self-review phase, so a reviewer's verdict tool has a phase to run in.
    phases: selfReviewWorkBoard.phases as Record<string, BoardPhaseDefinition<string>>,
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
