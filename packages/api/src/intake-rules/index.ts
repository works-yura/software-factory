import type { CreateCardActionOptions } from './create-card-action.ts';
import { createCardAction } from './create-card-action.ts';
import { IntakeRuleEngine } from './engine.ts';
import type { IntakeRuleEngineOptions } from './engine.ts';
import { IntakeKindRegistry } from './kinds.ts';
import type { IntakeActionKind, IntakeKinds, IntakePolicyKind, IntakeTriggerKind } from './kinds.ts';
import { alwaysPolicy, skipIfOpenPolicy } from './policies.ts';
import { createScheduleTrigger } from './schedule-trigger.ts';
import type { ScheduleTriggerOptions } from './schedule-trigger.ts';

export * from './create-card-action.ts';
export * from './engine.ts';
export * from './kinds.ts';
export * from './policies.ts';
export * from './routes.ts';
export * from './schedule-trigger.ts';

export interface IntakeRulesSetupOptions extends Omit<IntakeRuleEngineOptions, 'kinds'> {
  schedule: ScheduleTriggerOptions;
  cards: CreateCardActionOptions;
  /** Kinds a host adds next to the built-in ones. */
  extra?: {
    triggers?: IntakeTriggerKind<any>[];
    actions?: IntakeActionKind<any>[];
    policies?: IntakePolicyKind[];
  };
}

/**
 * The server's intake-rule kinds and engine: the `schedule` trigger, the `create-card` action and
 * the `skip-if-open` / `always` policies, plus whatever the host adds. `workflows` must be
 * registered on the host's Mastra for the schedule trigger to fire.
 */
export function setupIntakeRules(options: IntakeRulesSetupOptions) {
  const schedule = createScheduleTrigger(options.schedule);
  const kinds: IntakeKinds = {
    triggers: new IntakeKindRegistry<IntakeTriggerKind<any>>([schedule.trigger, ...(options.extra?.triggers ?? [])]),
    actions: new IntakeKindRegistry<IntakeActionKind<any>>([createCardAction(options.cards), ...(options.extra?.actions ?? [])]),
    policies: new IntakeKindRegistry<IntakePolicyKind>([
      skipIfOpenPolicy({ workItems: options.cards.workItems, boards: options.cards.boards }),
      alwaysPolicy,
      ...(options.extra?.policies ?? []),
    ]),
  };
  const engine = new IntakeRuleEngine({ ...options, kinds });
  return { engine, workflows: { [schedule.workflow.id]: schedule.workflow } };
}
