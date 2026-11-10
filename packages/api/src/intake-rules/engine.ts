/**
 * The one service that runs intake rules: a trigger fires → the rule's policy decides → its action
 * runs → the outcome is recorded. It also keeps each rule's trigger armed to match the rule (on
 * every change, and for all rules at boot) and presents rules for the routes.
 */

import type { IntakeRule, IntakeRuleFire, IntakeRuleLocale } from '@factory/contracts';
import type { IntakeRuleFireRecord, IntakeRuleRecord, IntakeRulesStorage } from '@factory/store';

import { IntakeConfigError } from './kinds.ts';
import type { IntakeKinds, IntakeTriggerFired } from './kinds.ts';

export type IntakeRuleStore = Pick<
  IntakeRulesStorage,
  'getById' | 'listAll' | 'recordFire' | 'listFires' | 'lastFireWithWorkItem'
>;

export interface IntakeRuleEngineOptions {
  rules: IntakeRuleStore;
  kinds: IntakeKinds;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  now?: () => Date;
}

const NEXT_FIRES = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function presentFire(fire: IntakeRuleFireRecord): IntakeRuleFire {
  return {
    id: fire.id,
    firedAt: fire.firedAt.toISOString(),
    triggerKind: fire.triggerKind,
    outcome: fire.outcome,
    workItemId: fire.workItemId,
    reason: fire.reason,
  };
}

export class IntakeRuleEngine {
  readonly kinds: IntakeKinds;
  readonly #rules: IntakeRuleStore;
  readonly #logger: NonNullable<IntakeRuleEngineOptions['logger']>;
  readonly #now: () => Date;
  #started = false;

  constructor(options: IntakeRuleEngineOptions) {
    this.kinds = options.kinds;
    this.#rules = options.rules;
    this.#logger = options.logger ?? { warn: (message, meta) => console.warn(`[intake-rules] ${message}`, meta ?? {}) };
    this.#now = options.now ?? (() => new Date());
  }

  /** Starts every trigger kind with this engine as its sink. Idempotent. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const trigger of this.kinds.triggers.list()) await trigger.start(fired => this.fire(fired).then(() => undefined));
  }

  /** Arms every enabled rule's trigger and disarms the rest: what boot runs once storage is up. */
  async armAll(): Promise<void> {
    for (const rule of await this.#rules.listAll()) {
      try {
        await this.sync(rule);
      } catch (error) {
        this.#logger.warn('could not arm an intake rule', { ruleId: rule.id, error: errorMessage(error) });
      }
    }
  }

  /** Makes the rule's trigger match the rule: armed while enabled, disarmed when paused. */
  async sync(rule: IntakeRuleRecord, previousTriggerKind?: string): Promise<void> {
    if (previousTriggerKind && previousTriggerKind !== rule.triggerKind) {
      await this.kinds.triggers.get(previousTriggerKind)?.disarm(rule.id);
    }
    const trigger = this.kinds.triggers.get(rule.triggerKind);
    if (!trigger) throw new IntakeConfigError(`This server has no "${rule.triggerKind}" trigger.`);
    if (!rule.enabled) {
      await trigger.disarm(rule.id);
      return;
    }
    await trigger.arm(rule, trigger.parse(rule.triggerConfig));
  }

  /** Stops the rule's trigger for good, before the rule is deleted. */
  async remove(rule: IntakeRuleRecord): Promise<void> {
    await this.kinds.triggers.get(rule.triggerKind)?.disarm(rule.id);
  }

  /** Checks a rule's three kinds and configs before it is saved; throws `IntakeConfigError`. */
  validate(rule: Pick<IntakeRuleRecord, 'triggerKind' | 'triggerConfig' | 'actionKind' | 'actionConfig' | 'policyKind'>) {
    const trigger = this.kinds.triggers.get(rule.triggerKind);
    if (!trigger) throw new IntakeConfigError(`Unknown trigger "${rule.triggerKind}".`);
    const action = this.kinds.actions.get(rule.actionKind);
    if (!action) throw new IntakeConfigError(`Unknown action "${rule.actionKind}".`);
    if (!this.kinds.policies.get(rule.policyKind)) throw new IntakeConfigError(`Unknown policy "${rule.policyKind}".`);
    return { trigger: trigger.parse(rule.triggerConfig), action: action.parse(rule.actionConfig) };
  }

  /** One fire, start to finish. Never throws for the rule's own problems: they are recorded as `failed`. */
  async fire(fired: IntakeTriggerFired): Promise<IntakeRuleFireRecord | null> {
    const rule = await this.#rules.getById(fired.ruleId);
    if (!rule) {
      // The rule was deleted under a trigger that had not heard yet: stop that trigger.
      await this.kinds.triggers.get(fired.triggerKind)?.disarm(fired.ruleId);
      return null;
    }
    const record = (outcome: IntakeRuleFireRecord['outcome'], workItemId: string | null, reason: string | null) =>
      this.#rules.recordFire({
        orgId: rule.orgId,
        factoryProjectId: rule.factoryProjectId,
        ruleId: rule.id,
        firedAt: fired.firedAt,
        triggerKind: fired.triggerKind,
        outcome,
        workItemId,
        reason,
      });

    if (!rule.enabled) return record('skipped', null, 'The rule is paused.');
    try {
      const trigger = this.kinds.triggers.get(rule.triggerKind);
      const action = this.kinds.actions.get(rule.actionKind);
      const policy = this.kinds.policies.get(rule.policyKind);
      if (!action) return record('failed', null, `This server has no "${rule.actionKind}" action.`);
      if (!policy) return record('failed', null, `This server has no "${rule.policyKind}" policy.`);
      const decision = await policy.decide({ rule, fired, lastWork: await this.#rules.lastFireWithWorkItem(rule.id) });
      if (!decision.go) return record('skipped', null, decision.reason);
      const triggerConfig = trigger ? trigger.parse(rule.triggerConfig) : undefined;
      const timeZone = trigger && triggerConfig !== undefined ? trigger.timeZone?.(triggerConfig) : undefined;
      const outcome = await action.run({
        rule,
        config: action.parse(rule.actionConfig),
        fired,
        ...(timeZone ? { timeZone } : {}),
      });
      return record('done', outcome.workItemId, outcome.note ?? null);
    } catch (error) {
      this.#logger.warn('an intake rule fire failed', { ruleId: rule.id, error: errorMessage(error) });
      return record('failed', null, errorMessage(error));
    }
  }

  /** A trigger config in words with its next fires, or why it is not valid. */
  preview(kind: string, config: unknown, locale: IntakeRuleLocale) {
    const trigger = this.kinds.triggers.get(kind);
    if (!trigger) return { summary: '', nextFires: [], problems: [`Unknown trigger "${kind}".`] };
    try {
      const parsed = trigger.parse(config);
      return {
        summary: trigger.describe(parsed, locale),
        nextFires: (trigger.nextFires?.(parsed, this.#now(), NEXT_FIRES) ?? []).map(at => at.toISOString()),
        problems: [],
      };
    } catch (error) {
      return { summary: '', nextFires: [], problems: [errorMessage(error)] };
    }
  }

  /** The rule as the routes return it: each kind in words, next fires, last fire and problems. */
  async present(rule: IntakeRuleRecord, locale: IntakeRuleLocale): Promise<IntakeRule> {
    const problems: string[] = [];
    const describe = <C>(
      side: 'trigger' | 'action',
      kind: { parse(config: unknown): C; describe(config: C, locale: IntakeRuleLocale): string } | undefined,
      kindName: string,
      config: Record<string, unknown>,
    ): { summary: string; parsed?: C } => {
      if (!kind) {
        problems.push(`This server has no "${kindName}" ${side}.`);
        return { summary: kindName };
      }
      try {
        const parsed = kind.parse(config);
        return { summary: kind.describe(parsed, locale), parsed };
      } catch (error) {
        problems.push(errorMessage(error));
        return { summary: kindName };
      }
    };
    const trigger = this.kinds.triggers.get(rule.triggerKind);
    const action = this.kinds.actions.get(rule.actionKind);
    const policy = this.kinds.policies.get(rule.policyKind);
    const triggerView = describe('trigger', trigger, rule.triggerKind, rule.triggerConfig);
    const actionView = describe('action', action, rule.actionKind, rule.actionConfig);
    if (!policy) problems.push(`This server has no "${rule.policyKind}" policy.`);
    if (action && actionView.parsed !== undefined && action.problems) {
      problems.push(...(await action.problems(rule, actionView.parsed)));
    }
    const nextFires =
      rule.enabled && trigger?.nextFires && triggerView.parsed !== undefined
        ? trigger.nextFires(triggerView.parsed, this.#now(), NEXT_FIRES).map(at => at.toISOString())
        : [];
    const [lastFire] = await this.#rules.listFires(rule, rule.id, { limit: 1 });
    return {
      id: rule.id,
      name: rule.name,
      trigger: { kind: rule.triggerKind, config: rule.triggerConfig, summary: triggerView.summary },
      action: { kind: rule.actionKind, config: rule.actionConfig, summary: actionView.summary },
      policy: { kind: rule.policyKind, summary: policy?.label[locale] ?? rule.policyKind },
      enabled: rule.enabled,
      revision: rule.revision,
      createdBy: rule.createdBy,
      createdAt: rule.createdAt.toISOString(),
      updatedBy: rule.updatedBy,
      updatedAt: rule.updatedAt.toISOString(),
      nextFires,
      lastFire: lastFire ? presentFire(lastFire) : null,
      problems,
    };
  }
}
