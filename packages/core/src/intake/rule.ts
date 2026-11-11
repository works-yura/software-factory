/**
 * The intake-rule domain: what a rule is and what one fire of it did. A rule is a trigger (when),
 * an overlap policy (whether) and an action (what), each a `kind` looked up in its registry with
 * its config kept as opaque JSON; the kinds own the config shapes. Persistence implements
 * `IntakeRuleRepository` (`@factory/store`), the engine (`@factory/runtime`) runs fires.
 */

export const INTAKE_RULE_LOCALES = ['uk', 'en'] as const;
export type IntakeRuleLocale = (typeof INTAKE_RULE_LOCALES)[number];

/** A label in every locale the settings speak. */
export type LocalizedLabel = Readonly<Record<IntakeRuleLocale, string>>;

export interface IntakeRuleScope {
  orgId: string;
  factoryProjectId: string;
}

export interface IntakeRuleRecord extends IntakeRuleScope {
  id: string;
  name: string;
  triggerKind: string;
  triggerConfig: Record<string, unknown>;
  actionKind: string;
  actionConfig: Record<string, unknown>;
  /** The overlap policy's kind, e.g. `skip-if-open`. */
  policyKind: string;
  enabled: boolean;
  revision: number;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

/** The kind-and-config part of a rule: what validation reads. */
export type IntakeRuleKindsConfig = Pick<
  IntakeRuleRecord,
  'triggerKind' | 'triggerConfig' | 'actionKind' | 'actionConfig' | 'policyKind'
>;

/** `done`: the action ran; `skipped`: the policy held it back on purpose; `failed`: it could not run. */
export const INTAKE_RULE_FIRE_OUTCOMES = ['done', 'skipped', 'failed'] as const;
export type IntakeRuleFireOutcome = (typeof INTAKE_RULE_FIRE_OUTCOMES)[number];

export interface IntakeRuleFireRecord extends IntakeRuleScope {
  id: string;
  ruleId: string;
  firedAt: Date;
  /** The trigger kind that fired it (`schedule`, an event kind, …). */
  triggerKind: string;
  outcome: IntakeRuleFireOutcome;
  /** What the action made, when it made a card. */
  workItemId: string | null;
  reason: string | null;
  /**
   * The trigger's own id for this fire (a scheduler claim, an event id): the same fire delivered
   * twice carries the same key, so it is recorded and acted on once. Null for a fire without one.
   */
  fireKey: string | null;
}

/** One fire of a rule's trigger, as the trigger emits it. */
export interface IntakeTriggerFired {
  ruleId: string;
  firedAt: Date;
  triggerKind: string;
  /** Stable across redeliveries of this fire; see `IntakeRuleFireRecord.fireKey`. */
  fireKey?: string;
  /** What the trigger knows about this fire (an event's fields); template placeholders may read it. */
  payload?: Record<string, unknown>;
}

/** Where a trigger sends its fires; the engine is the only one listening. */
export type IntakeFireSink = (fired: IntakeTriggerFired) => Promise<void>;

/** The persistence the engine needs (a port; `IntakeRulesStorage` implements it). */
export interface IntakeRuleRepository {
  getById(id: string): Promise<IntakeRuleRecord | null>;
  listAll(): Promise<IntakeRuleRecord[]>;
  recordFire(input: Omit<IntakeRuleFireRecord, 'id'>): Promise<IntakeRuleFireRecord>;
  /** The fire recorded under `fireKey` for the rule, if any. */
  findFire(ruleId: string, fireKey: string): Promise<IntakeRuleFireRecord | null>;
  listFires(scope: IntakeRuleScope, ruleId: string, options?: { limit?: number }): Promise<IntakeRuleFireRecord[]>;
  /** The last fire whose action made a card: what an overlap policy checks. */
  lastFireWithWorkItem(ruleId: string): Promise<IntakeRuleFireRecord | null>;
}

/**
 * The intake route a rule's cards are placed by: intake routes are the one place that decides where
 * a new card goes, so a rule that files cards gets a route of its own (`intake.rule` = its id) when
 * it is created, which a person may then edit like any route. A port; the server implements it over
 * the stored intake routes.
 */
export interface IntakeRuleRoutes {
  /** Adds the rule's route unless a route already names the rule. */
  ensure(rule: IntakeRuleRecord, target: { boardKey: string; phaseKey: string | null }): Promise<void>;
  /** Removes the routes that name only this rule, when the rule is deleted. */
  remove(rule: IntakeRuleRecord): Promise<void>;
}

/** The condition of a rule's own intake route: cards this rule filed. */
export function intakeRuleRouteCondition(ruleId: string) {
  return { operator: 'AND' as const, conditions: [{ field: 'intake.rule', operator: 'equals' as const, value: ruleId }] };
}
