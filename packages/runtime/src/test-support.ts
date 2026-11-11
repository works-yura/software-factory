/**
 * v3 installed Work and Review in every registry it built by default. Here the
 * engine ships with none, so the copied suites run against these wrappers, which
 * install `@factory/pipelines` wherever a test leaves the boards out.
 */

import { randomUUID } from 'node:crypto';

import { validateFactoryRuleDecisions } from '@factory/core';
import { createPipelines } from '@factory/pipelines';
import type { WorkItemsStorage } from '@factory/store';

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

/**
 * Commits a move of the card into `stage` whose evaluation queued `decisions`, the way an accepted
 * transition persists the decisions its rules returned. Tests that exercise how the dispatcher
 * executes a decision queue it this way; phases themselves only ever start their runner.
 */
export async function commitDecisions(
  storage: WorkItemsStorage,
  input: {
    orgId?: string;
    factoryProjectId: string;
    workItemId: string;
    stage: string;
    decisions: readonly unknown[];
    ingress?: string;
    actorId?: string;
    configVersion?: string;
    causalChain?: Array<{ ingressId: string; decisionType: string }>;
  },
) {
  const orgId = input.orgId ?? 'org-1';
  const item = await storage.get({ orgId, id: input.workItemId });
  if (!item) throw new Error(`Expected work item ${input.workItemId}.`);
  const decisions = validateFactoryRuleDecisions(input.decisions, input.causalChain?.length ?? 0);
  const ingress = input.ingress ?? `commit-${randomUUID()}`;
  const committed = await storage.commitTransition({
    orgId,
    factoryProjectId: input.factoryProjectId,
    workItemId: input.workItemId,
    expectedRevision: item.revision,
    destinationStage: input.stage,
    actorId: input.actorId ?? 'factory-rule-dispatcher',
    ingress: { identity: ingress, triggerType: 'rule', transitionId: randomUUID() },
    configVersion: input.configVersion ?? 'rules-v1',
    causalChain: input.causalChain ?? [],
    evaluation: { outcome: 'accepted', decisions: decisions as unknown as Record<string, unknown>[] },
  });
  if (committed.status === 'missing') throw new Error(`Expected work item ${input.workItemId}.`);
  return committed;
}
