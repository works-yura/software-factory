/**
 * The `create-card` intake action (an adapter of the core `IntakeActionKind` port): a fire files
 * one card through the same path as "New card" (`createFactoryWorkItem`). The card carries its
 * origin (`metadata.intakeRule`), so the project's intake routes decide where it lands like any
 * new card; the rule's own board and phase are the default when no route takes it. From there the
 * board's phases take it: a phase that starts on its own (`autoStart`) runs its agent.
 *
 * Idempotent per fire: a fire with a `fireKey` that already made a card (a scheduler step retried
 * after the card was filed but before the fire was recorded) returns that card instead of a second.
 */

import {
  createCardActionConfigSchema,
  INTAKE_RULE_METADATA_KEY,
  intakeRuleOrigin,
  intakeTargetProblem,
  IntakeTargetError,
  parseWith,
  renderIntakeTemplate,
} from '@factory/core';
import type {
  BoardRegistry,
  CreateCardActionConfig,
  IntakeActionKind,
  IntakeRoutesReader,
  IntakeRuleCardOrigin,
  IntakeRuleScope,
} from '@factory/core';
import type { AuditRecorder, FactoryTransitionService } from '@factory/runtime';
import type { WorkItemsStorage } from '@factory/store';

import { createFactoryWorkItem } from './create-work-item.ts';

export const CREATE_CARD_ACTION_KIND = 'create-card';

/** The system actor that files and places a rule's cards. */
export const INTAKE_RULE_ACTOR = 'factory-intake-rule';

export interface CreateCardActionOptions {
  workItems: WorkItemsStorage;
  /** The project's boards, stored ones included. */
  boards: { load(scope: IntakeRuleScope): Promise<BoardRegistry> };
  /** The project's intake routes: they place the card first. */
  intakeRoutes?: IntakeRoutesReader;
  transitionService: () => Pick<FactoryTransitionService, 'transition'> | undefined;
  auditRecorder: AuditRecorder;
}

/** Why the rule's default target can't take new cards in this project, or undefined. */
function targetProblem(registry: BoardRegistry, config: CreateCardActionConfig): string | undefined {
  return intakeTargetProblem(registry, {
    target: { boardKey: config.boardKey, phaseKey: config.phaseKey },
    on: ['work_item.created'],
  })?.message;
}

export function createCardAction(options: CreateCardActionOptions): IntakeActionKind<CreateCardActionConfig> {
  /** The card an earlier delivery of this fire made, if any. */
  const cardFromFire = async (scope: IntakeRuleScope, ruleId: string, fireKey: string) => {
    for (const card of await options.workItems.listShared(scope)) {
      const origin = intakeRuleOrigin(card.metadata);
      if (origin?.id === ruleId && origin.fireKey === fireKey) return card;
    }
    return undefined;
  };

  return {
    kind: CREATE_CARD_ACTION_KIND,
    label: { uk: 'Створити картку', en: 'Create a card' },
    parse: config => parseWith(createCardActionConfigSchema, config),
    describe: (config, locale) => {
      const where = config.phaseKey ? `${config.boardKey} › ${config.phaseKey}` : config.boardKey;
      return locale === 'uk' ? `Картка «${config.titleTemplate}» на ${where}` : `Card "${config.titleTemplate}" on ${where}`;
    },
    routeTarget: config => ({ boardKey: config.boardKey, phaseKey: config.phaseKey }),
    problems: async (scope, config) => {
      const problem = targetProblem(await options.boards.load(scope), config);
      return problem ? [problem] : [];
    },
    run: async ({ rule, config, fired, timeZone }) => {
      const scope = { orgId: rule.orgId, factoryProjectId: rule.factoryProjectId };
      if (fired.fireKey) {
        const earlier = await cardFromFire(scope, rule.id, fired.fireKey);
        if (earlier) return { workItemId: earlier.id, note: 'This fire had already filed its card.' };
      }
      const registry = await options.boards.load(scope);
      const problem = targetProblem(registry, config);
      if (problem) throw new IntakeTargetError(problem);
      const template = {
        firedAt: fired.firedAt,
        ruleName: rule.name,
        ...(timeZone ? { timeZone } : {}),
        ...(fired.payload ? { payload: fired.payload } : {}),
      };
      const description = renderIntakeTemplate(config.description, template).trim();
      const origin: IntakeRuleCardOrigin = {
        id: rule.id,
        name: rule.name,
        triggerKind: fired.triggerKind,
        firedAt: fired.firedAt.toISOString(),
        ...(fired.fireKey ? { fireKey: fired.fireKey } : {}),
      };
      const created = await createFactoryWorkItem({
        workItems: options.workItems,
        boards: registry,
        transitionService: options.transitionService(),
        audit: async input => {
          await options.auditRecorder.record({
            orgId: rule.orgId,
            actorId: `${INTAKE_RULE_ACTOR}:${rule.id}`,
            actorType: 'system',
            ...input,
          });
        },
        orgId: rule.orgId,
        // The person who set the rule up files its cards: they are its creator and consented to its runs.
        userId: rule.createdBy,
        factoryProjectId: rule.factoryProjectId,
        input: {
          title: renderIntakeTemplate(config.titleTemplate, template).slice(0, 500) || rule.name,
          metadata: {
            ...(description ? { description } : {}),
            ...(config.repository ? { repository: config.repository } : {}),
            [INTAKE_RULE_METADATA_KEY]: origin,
          },
        },
        ...(options.intakeRoutes ? { intakeRoutes: options.intakeRoutes } : {}),
        defaultPlacement: { board: config.boardKey, phase: config.phaseKey, actorId: INTAKE_RULE_ACTOR },
      });
      if (created.status === 'refused') throw new Error(created.message);
      if (created.status === 'rejected') throw new Error(created.reason);
      return { workItemId: created.item.id };
    },
  };
}
