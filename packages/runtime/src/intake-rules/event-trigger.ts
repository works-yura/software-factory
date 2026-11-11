/**
 * A trigger kind driven by events instead of a clock (Observer). It subscribes once to an
 * `IntakeEventSource` and, for each event, fires every armed rule of the event's project whose
 * config `matches` it. The event's id is the fire key, so a redelivered event fires once; its facts
 * become the fire's payload (`{payload.<key>}` in templates).
 *
 * A concrete event trigger («PR змерджено», «картка перейшла у фазу») is this function with its
 * own config schema and matcher, plus an adapter that publishes the provider's events.
 */

import { parseWith } from '@factory/core';
import type {
  IntakeEvent,
  IntakeEventSource,
  IntakeFireSink,
  IntakeRuleLocale,
  IntakeRuleScope,
  IntakeTriggerKind,
  LocalizedLabel,
} from '@factory/core';
import type { z } from 'zod';

export interface EventTriggerOptions<S extends z.ZodType> {
  kind: string;
  label: LocalizedLabel;
  source: IntakeEventSource;
  /** The rule's config: which events it takes. */
  schema: S;
  describe(config: z.output<S>, locale: IntakeRuleLocale): string;
  matches(config: z.output<S>, event: IntakeEvent): boolean;
}

interface ArmedRule<C> {
  scope: IntakeRuleScope;
  config: C;
}

export function eventTriggerKind<S extends z.ZodType>(options: EventTriggerOptions<S>): IntakeTriggerKind<z.output<S>> {
  const armed = new Map<string, ArmedRule<z.output<S>>>();
  let sink: IntakeFireSink | undefined;
  let unsubscribe: (() => void) | undefined;

  const onEvent = async (event: IntakeEvent) => {
    if (!sink) return;
    for (const [ruleId, rule] of armed) {
      if (rule.scope.orgId !== event.scope.orgId || rule.scope.factoryProjectId !== event.scope.factoryProjectId) continue;
      if (!options.matches(rule.config, event)) continue;
      await sink({
        ruleId,
        firedAt: event.occurredAt,
        triggerKind: options.kind,
        fireKey: `event:${event.id}`,
        payload: { type: event.type, ...event.facts },
      });
    }
  };

  return {
    kind: options.kind,
    label: options.label,
    parse: config => parseWith(options.schema, config),
    describe: options.describe,
    start: next => {
      sink = next;
      unsubscribe ??= options.source.subscribe(onEvent);
    },
    arm: async (rule, config) => {
      armed.set(rule.id, { scope: { orgId: rule.orgId, factoryProjectId: rule.factoryProjectId }, config });
    },
    disarm: async ruleId => {
      armed.delete(ruleId);
    },
  };
}
