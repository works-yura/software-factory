import { intakeKinds } from '@factory/core';
import type { IntakeActionKind, IntakePolicyKind, IntakeTriggerKind, IntakeTriggerRouteRepository } from '@factory/core';
import { alwaysPolicy, IntakeTriggerEngine, skipIfOpenPolicy } from '@factory/runtime';
import type { IntakeCardReader, IntakeTriggerEngineOptions } from '@factory/runtime';
import { createCardAction } from '@factory/work-items';
import type { CreateCardActionOptions } from '@factory/work-items';

import { createScheduleTrigger } from './schedule-trigger.ts';
import type { ScheduleTriggerOptions } from './schedule-trigger.ts';

/**
 * The composition root of trigger routes (ADR-0021): the only place that names concrete trigger,
 * action and policy kinds. Everything else goes through the core ports and the registries.
 */
export interface IntakeTriggersSetupOptions extends Omit<IntakeTriggerEngineOptions, 'kinds' | 'routes'> {
  routes: IntakeTriggerRouteRepository;
  schedule: ScheduleTriggerOptions;
  cards: CreateCardActionOptions & { reader: IntakeCardReader };
  /** More kinds to register (an event trigger, a notify action, a test double). */
  extra?: {
    triggers?: IntakeTriggerKind<any>[];
    actions?: IntakeActionKind<any>[];
    policies?: IntakePolicyKind[];
  };
}

export function setupIntakeTriggers(options: IntakeTriggersSetupOptions) {
  const schedule = createScheduleTrigger(options.schedule);
  const { reader, ...cards } = options.cards;
  const kinds = intakeKinds({
    triggers: [schedule.trigger, ...(options.extra?.triggers ?? [])],
    actions: [createCardAction({ ...cards, reader }), ...(options.extra?.actions ?? [])],
    policies: [skipIfOpenPolicy({ cards: reader, boards: cards.boards }), alwaysPolicy, ...(options.extra?.policies ?? [])],
  });
  const { schedule: _schedule, cards: _cards, extra: _extra, ...engineOptions } = options;
  const engine = new IntakeTriggerEngine({ ...engineOptions, kinds });
  return { engine, kinds, workflows: { [schedule.workflow.id]: schedule.workflow } };
}
