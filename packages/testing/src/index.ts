/**
 * v3 installed Work and Review in every registry and storage seed it built by
 * default. The v4 engine ships with none, so suites copied from v3 run against
 * these wrappers, which install those boards wherever a test leaves boards out.
 */

import { createDefaultBoardRegistry } from '@factory/pipelines';
import {
  FactoryDecisionDispatcher as DecisionDispatcher,
  FactoryTransitionService as TransitionService,
} from '@factory/runtime';
import type { FactoryDecisionDispatcherOptions, FactoryTransitionServiceOptions } from '@factory/runtime';
import { createFactoryStorageForTests as createStorage } from '@factory/store/testing';

export * from '@factory/store/testing';
export * from '@factory/runtime';
export { createDefaultBoardRegistry as createBoardRegistry } from '@factory/pipelines';

export class FactoryTransitionService extends TransitionService {
  constructor(options: FactoryTransitionServiceOptions) {
    super({ ...options, boards: options.boards ?? createDefaultBoardRegistry() });
  }
}

export class FactoryDecisionDispatcher extends DecisionDispatcher {
  constructor(options: FactoryDecisionDispatcherOptions) {
    super({ ...options, boards: options.boards ?? createDefaultBoardRegistry() });
  }
}

export function createFactoryStorageForTests() {
  return createStorage({ boards: createDefaultBoardRegistry() });
}
