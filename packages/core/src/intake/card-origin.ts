/**
 * How a card says it came from an intake rule, and what routes can test about that. The
 * `create-card` action stamps `metadata.intakeRule`; `cardRuleFacts` turns it into
 * `source.kind = intake_rule`, `intake.rule` and `intake.trigger`, so an intake route can take
 * cards from any rule, from one rule, or from one trigger kind.
 */

/** Card metadata naming the rule and fire a card came from. */
export const INTAKE_RULE_METADATA_KEY = 'intakeRule';

/** `source.kind` of a card an intake rule filed. */
export const INTAKE_RULE_SOURCE_KIND = 'intake_rule';

export interface IntakeRuleCardOrigin {
  id: string;
  name: string;
  triggerKind: string;
  firedAt: string;
  /** The fire's key, when its trigger gave one: how a redelivered fire finds the card it made. */
  fireKey?: string;
}

/** The rule a card came from, read from its metadata; undefined for any other card. */
export function intakeRuleOrigin(metadata: Record<string, unknown> | null | undefined): IntakeRuleCardOrigin | undefined {
  const value = metadata?.[INTAKE_RULE_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const origin = value as Record<string, unknown>;
  if (typeof origin.id !== 'string' || typeof origin.name !== 'string') return undefined;
  return {
    id: origin.id,
    name: origin.name,
    // Cards filed before the trigger was stamped came from the only trigger there was.
    triggerKind: typeof origin.triggerKind === 'string' ? origin.triggerKind : 'schedule',
    firedAt: typeof origin.firedAt === 'string' ? origin.firedAt : '',
    ...(typeof origin.fireKey === 'string' ? { fireKey: origin.fireKey } : {}),
  };
}
