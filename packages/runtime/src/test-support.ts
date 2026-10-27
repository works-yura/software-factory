/**
 * v3 installed Work and Review in every registry it built by default. Here the
 * engine ships with none, so the copied suites run against these wrappers, which
 * install `@factory/pipelines` wherever a test leaves the boards out.
 */

import { createPipelines } from '@factory/pipelines';

export { createDefaultBoardRegistry as createBoardRegistry } from '@factory/pipelines';
import { createFactoryStorageForTests as createStorage } from '@factory/store/testing';

import { FactoryDecisionDispatcher as DecisionDispatcher } from './dispatcher.ts';
import type { FactoryDecisionDispatcherOptions } from './dispatcher.ts';
import { FactoryTransitionService as TransitionService } from './transition-service.ts';
import type { FactoryTransitionServiceOptions } from './transition-service.ts';

export class FactoryTransitionService extends TransitionService {
  constructor(options: FactoryTransitionServiceOptions) {
    super({ ...options, boards: options.boards ?? createPipelines() });
  }
}

export class FactoryDecisionDispatcher extends DecisionDispatcher {
  constructor(options: FactoryDecisionDispatcherOptions) {
    super({ ...options, boards: options.boards ?? createPipelines() });
  }
}

export function createFactoryStorageForTests() {
  return createStorage({ boards: createPipelines() });
}
