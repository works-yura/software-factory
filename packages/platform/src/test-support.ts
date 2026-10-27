/**
 * v3 installed Work and Review in every registry and storage seed it built by
 * default. The v4 engine ships with none, so the copied suites run against these
 * wrappers, which install `@factory/pipelines` wherever a test leaves boards out.
 */

import { createPipelines } from '@factory/pipelines';
import {
  FactoryDecisionDispatcher as DecisionDispatcher,
  FactoryTransitionService as TransitionService,
} from '@factory/runtime';
import type { FactoryDecisionDispatcherOptions, FactoryTransitionServiceOptions } from '@factory/runtime';
import { createFactoryStorageForTests as createStorage } from '@factory/store/testing';

export * from '@factory/store/testing';
export * from '@factory/runtime';
export { createDefaultBoardRegistry as createBoardRegistry } from './boards.ts';

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
