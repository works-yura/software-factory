/**
 * The application service for intake rules: the use cases the HTTP routes and the triggers call.
 *
 * - **Fire**: a trigger fired → the rule's policy decides → its action runs → the outcome is
 *   recorded. A fire carrying a `fireKey` that is already recorded returns that record: a
 *   redelivered fire (a retried scheduler step) never acts twice.
 * - **Save**: validate a rule's kinds and configs (and that its action can run now), then keep its
 *   trigger armed while enabled and disarmed while paused or deleted; at boot, arm every rule.
 * - **Read**: a trigger config in words with its next fires (preview), a rule's state (inspect).
 *
 * It depends only on `@factory/core` ports: the kind registries and `IntakeRuleRepository`. It
 * knows no concrete kind, no Mastra and no HTTP; the server's composition root wires those.
 */

import {
  IntakeConfigError,
  IntakeError,
  IntakeTargetError,
  IntakeTriggerUnavailableError,
  IntakeUnknownKindError,
} from '@factory/core';
import type {
  IntakeKinds,
  IntakeRuleFireRecord,
  IntakeRuleKindsConfig,
  IntakeRuleLocale,
  IntakeRuleRecord,
  IntakeRuleRepository,
  IntakeRuleScope,
  IntakeTriggerFired,
} from '@factory/core';

export interface IntakeRuleEngineOptions {
  rules: IntakeRuleRepository;
  kinds: IntakeKinds;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  now?: () => Date;
}

/** One kind as the settings list it. */
export interface IntakeKindListing {
  kind: string;
  label: string;
}

/** A trigger config in words, with its next fires; `problems` says why it is not valid. */
export interface IntakeTriggerPreview {
  summary: string;
  nextFires: Date[];
  problems: string[];
}

/** A rule's state for the settings: each kind in words, next fires, last fire and what blocks it. */
export interface IntakeRuleInspection {
  triggerSummary: string;
  actionSummary: string;
  policySummary: string;
  nextFires: Date[];
  lastFire: IntakeRuleFireRecord | null;
  problems: string[];
}

const NEXT_FIRES = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class IntakeRuleEngine {
  readonly #kinds: IntakeKinds;
  readonly #rules: IntakeRuleRepository;
  readonly #logger: NonNullable<IntakeRuleEngineOptions['logger']>;
  readonly #now: () => Date;
  #started = false;

  constructor(options: IntakeRuleEngineOptions) {
    this.#kinds = options.kinds;
    this.#rules = options.rules;
    this.#logger = options.logger ?? { warn: (message, meta) => console.warn(`[intake-rules] ${message}`, meta ?? {}) };
    this.#now = options.now ?? (() => new Date());
  }

  /** Starts every trigger kind with this engine as its sink. Idempotent. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const trigger of this.#kinds.triggers.list()) await trigger.start(fired => this.fire(fired).then(() => undefined));
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

  /** The kinds this server offers, labelled in `locale`. */
  listKinds(locale: IntakeRuleLocale): { triggers: IntakeKindListing[]; actions: IntakeKindListing[]; policies: IntakeKindListing[] } {
    const listing = (kinds: readonly { kind: string; label: Record<IntakeRuleLocale, string> }[]) =>
      kinds.map(kind => ({ kind: kind.kind, label: kind.label[locale] }));
    return {
      triggers: listing(this.#kinds.triggers.list()),
      actions: listing(this.#kinds.actions.list()),
      policies: listing(this.#kinds.policies.list()),
    };
  }

  /**
   * Checks a rule before it is saved: its three kinds exist, their configs fit, and its action can
   * run in `scope` now. Throws `IntakeError` (`unknown_kind`, `invalid_config`, `target_unavailable`).
   */
  async validate(rule: IntakeRuleKindsConfig, scope: IntakeRuleScope): Promise<void> {
    const trigger = this.#kinds.triggers.get(rule.triggerKind);
    if (!trigger) throw new IntakeUnknownKindError('trigger', rule.triggerKind);
    const action = this.#kinds.actions.get(rule.actionKind);
    if (!action) throw new IntakeUnknownKindError('action', rule.actionKind);
    if (!this.#kinds.policies.get(rule.policyKind)) throw new IntakeUnknownKindError('policy', rule.policyKind);
    trigger.parse(rule.triggerConfig);
    const problems = (await action.problems?.(scope, action.parse(rule.actionConfig))) ?? [];
    if (problems.length > 0) throw new IntakeTargetError(problems.join(' '));
  }

  /**
   * Makes the rule's trigger match the rule: armed while enabled, disarmed when paused. A trigger
   * that can't be armed or stopped throws `IntakeTriggerUnavailableError`.
   */
  async sync(rule: IntakeRuleRecord, previousTriggerKind?: string): Promise<void> {
    const trigger = this.#kinds.triggers.get(rule.triggerKind);
    if (!trigger) throw new IntakeUnknownKindError('trigger', rule.triggerKind);
    const config = trigger.parse(rule.triggerConfig);
    await this.#triggerCall(rule.enabled ? 'armed' : 'stopped', async () => {
      if (previousTriggerKind && previousTriggerKind !== rule.triggerKind) {
        await this.#kinds.triggers.get(previousTriggerKind)?.disarm(rule.id);
      }
      if (rule.enabled) await trigger.arm(rule, config);
      else await trigger.disarm(rule.id);
    });
  }

  /** Stops the rule's trigger for good, before the rule is deleted. */
  async remove(rule: IntakeRuleRecord): Promise<void> {
    await this.#triggerCall('stopped', async () => {
      await this.#kinds.triggers.get(rule.triggerKind)?.disarm(rule.id);
    });
  }

  async #triggerCall(what: 'armed' | 'stopped', call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (error instanceof IntakeError) throw error;
      throw new IntakeTriggerUnavailableError(`The rule's trigger could not be ${what}: ${errorMessage(error)}`);
    }
  }

  /**
   * One fire, start to finish. Never throws for the rule's own problems: they are recorded as
   * `failed`. A fire whose `fireKey` is already recorded returns that record and does nothing.
   */
  async fire(fired: IntakeTriggerFired): Promise<IntakeRuleFireRecord | null> {
    if (fired.fireKey) {
      const recorded = await this.#rules.findFire(fired.ruleId, fired.fireKey);
      if (recorded) return recorded;
    }
    const rule = await this.#rules.getById(fired.ruleId);
    if (!rule) {
      // The rule was deleted under a trigger that had not heard yet: stop that trigger.
      await this.#kinds.triggers.get(fired.triggerKind)?.disarm(fired.ruleId);
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
        fireKey: fired.fireKey ?? null,
      });

    if (!rule.enabled) return record('skipped', null, 'The rule is paused.');
    try {
      const action = this.#kinds.actions.get(rule.actionKind);
      if (!action) throw new IntakeUnknownKindError('action', rule.actionKind);
      const policy = this.#kinds.policies.get(rule.policyKind);
      if (!policy) throw new IntakeUnknownKindError('policy', rule.policyKind);
      const decision = await policy.decide({ rule, fired, lastWork: await this.#rules.lastFireWithWorkItem(rule.id) });
      if (!decision.go) return record('skipped', null, decision.reason);
      const trigger = this.#kinds.triggers.get(rule.triggerKind);
      const timeZone = trigger?.timeZone?.(trigger.parse(rule.triggerConfig));
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
  preview(kind: string, config: unknown, locale: IntakeRuleLocale): IntakeTriggerPreview {
    const trigger = this.#kinds.triggers.get(kind);
    if (!trigger) return { summary: '', nextFires: [], problems: [new IntakeUnknownKindError('trigger', kind).message] };
    try {
      const parsed = trigger.parse(config);
      return {
        summary: trigger.describe(parsed, locale),
        nextFires: trigger.nextFires?.(parsed, this.#now(), NEXT_FIRES) ?? [],
        problems: [],
      };
    } catch (error) {
      if (!(error instanceof IntakeConfigError)) throw error;
      return { summary: '', nextFires: [], problems: [error.message] };
    }
  }

  /** The rule's state: each kind in words, next fires, last fire, and why it can't run as it stands. */
  async inspect(rule: IntakeRuleRecord, locale: IntakeRuleLocale): Promise<IntakeRuleInspection> {
    const problems: string[] = [];
    const describe = <C>(
      side: 'trigger' | 'action',
      kind: { parse(config: unknown): C; describe(config: C, locale: IntakeRuleLocale): string } | undefined,
      kindName: string,
      config: Record<string, unknown>,
    ): { summary: string; parsed?: C } => {
      if (!kind) {
        problems.push(new IntakeUnknownKindError(side, kindName).message);
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
    const trigger = this.#kinds.triggers.get(rule.triggerKind);
    const action = this.#kinds.actions.get(rule.actionKind);
    const policy = this.#kinds.policies.get(rule.policyKind);
    const triggerView = describe('trigger', trigger, rule.triggerKind, rule.triggerConfig);
    const actionView = describe('action', action, rule.actionKind, rule.actionConfig);
    if (!policy) problems.push(new IntakeUnknownKindError('policy', rule.policyKind).message);
    if (action?.problems && actionView.parsed !== undefined) problems.push(...(await action.problems(rule, actionView.parsed)));
    const nextFires =
      rule.enabled && trigger?.nextFires && triggerView.parsed !== undefined
        ? trigger.nextFires(triggerView.parsed, this.#now(), NEXT_FIRES)
        : [];
    const [lastFire] = await this.#rules.listFires(rule, rule.id, { limit: 1 });
    return {
      triggerSummary: triggerView.summary,
      actionSummary: actionView.summary,
      policySummary: policy?.label[locale] ?? rule.policyKind,
      nextFires,
      lastFire: lastFire ?? null,
      problems,
    };
  }
}
