/**
 * The composition root of intake rules: the only place that names concrete kinds. It builds the
 * registries — the Mastra-backed `schedule` trigger, the `create-card` action, the `skip-if-open`
 * and `always` policies, plus whatever the host adds — and the engine over the rules repository.
 * `workflows` must be registered on the host's Mastra for the schedule trigger to fire.
 */

import { intakeKinds } from '@factory/core';
import type { IntakeActionKind, IntakePolicyKind, IntakeRuleRepository, IntakeTriggerKind } from '@factory/core';
import { alwaysPolicy, IntakeRuleEngine, skipIfOpenPolicy } from '@factory/runtime';
import type { IntakeRuleEngineOptions } from '@factory/runtime';
import { createCardAction } from '@factory/work-items';
import type { CreateCardActionOptions } from '@factory/work-items';

import { createScheduleTrigger } from './schedule-trigger.ts';
import type { ScheduleTriggerOptions } from './schedule-trigger.ts';

export interface IntakeRulesSetupOptions extends Omit<IntakeRuleEngineOptions, 'kinds' | 'rules'> {
  rules: IntakeRuleRepository;
  schedule: ScheduleTriggerOptions;
  cards: CreateCardActionOptions;
  /** Kinds a host adds next to the built-in ones. */
  extra?: {
    triggers?: IntakeTriggerKind<any>[];
    actions?: IntakeActionKind<any>[];
    policies?: IntakePolicyKind[];
  };
}

export function setupIntakeRules(options: IntakeRulesSetupOptions) {
  const schedule = createScheduleTrigger(options.schedule);
  const kinds = intakeKinds({
    triggers: [schedule.trigger, ...(options.extra?.triggers ?? [])],
    actions: [createCardAction(options.cards), ...(options.extra?.actions ?? [])],
    policies: [
      skipIfOpenPolicy({ cards: options.cards.workItems, boards: options.cards.boards }),
      alwaysPolicy,
      ...(options.extra?.policies ?? []),
    ],
  });
  const { schedule: _schedule, cards: _cards, extra: _extra, ...engineOptions } = options;
  const engine = new IntakeRuleEngine({ ...engineOptions, kinds });
  return { engine, kinds, workflows: { [schedule.workflow.id]: schedule.workflow } };
}
