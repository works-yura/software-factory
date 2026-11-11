import type { RuleGroup } from '@factory/core';
import type { IntakeRouteFiresStorage, StoredBoardsStorage } from '@factory/store';

/** The actor on records the Audits board phase upgrade rewrites. */
export const AUDITS_BOARD_UPGRADE_ACTOR = 'system:audits-board-phases';

/** The actor that removes the paired routes migrated intake rules used to place their cards. */
export const INTAKE_RULE_MIGRATION_ACTOR = 'system:intake-rule-migration';

/** Whether a route's condition reads the retired `intake.rule` / `intake.trigger` card facts. */
function namesRetiredRuleFacts(when: RuleGroup | null): boolean {
  if (!when) return false;
  return when.conditions.some(member =>
    'conditions' in member
      ? namesRetiredRuleFacts(member)
      : member.field === 'intake.rule' || member.field === 'intake.trigger',
  );
}

export interface LegacyIntakeRulesMigration {
  /** Rules turned into trigger routes on this run. */
  migrated: number;
  /** Routes removed that placed rule cards by `intake.rule` (the trigger route places its own now). */
  removedRoutes: number;
}

/**
 * Before routes made cards, an «intake rule» (ADR-0015/0016) did, with an intake route of its own
 * on `intake.rule` placing them. Each rule becomes a trigger route with the rule's id (so its core
 * schedule row and its fires stay keyed the same way), its target taken from its `create-card`
 * action, its creator kept as the route's creator (the person whose consent its runs carry). Its
 * fires are copied to the route fire log, the paired placing route is removed, and the legacy rows
 * are deleted. Idempotent: a rule already migrated (its route exists) only finishes the cleanup,
 * and the route's fixed id means a second replica migrating at the same time adds it once.
 * `renames` moves a target off a board's retired phases on the way (the Audits board's).
 */
export async function migrateLegacyIntakeRules({
  fires,
  boards,
  renames = {},
}: {
  fires: Pick<IntakeRouteFiresStorage, 'listLegacyRules' | 'copyLegacyFires' | 'deleteLegacyRule'>;
  boards: Pick<StoredBoardsStorage, 'createIntakeRoute' | 'listIntakeRoutes' | 'deleteIntakeRoute'>;
  /** Board key → retired phase → its replacement. */
  renames?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}): Promise<LegacyIntakeRulesMigration> {
  const result: LegacyIntakeRulesMigration = { migrated: 0, removedRoutes: 0 };
  for (const rule of await fires.listLegacyRules()) {
    const scope = { orgId: rule.orgId, factoryProjectId: rule.factoryProjectId };
    const { boardKey, phaseKey, ...action } = rule.actionConfig as {
      boardKey?: unknown;
      phaseKey?: unknown;
    } & Record<string, unknown>;
    if (typeof boardKey !== 'string') {
      console.warn(`[factory] intake rule ${rule.id} has no target board; it was not migrated and stays in the legacy table`);
      continue;
    }
    const phase = typeof phaseKey === 'string' ? (renames[boardKey]?.[phaseKey] ?? phaseKey) : null;
    const existing = (await boards.listIntakeRoutes(scope)).find(route => route.id === rule.id);
    if (!existing) {
      await boards.createIntakeRoute(
        scope,
        {
          name: rule.name,
          enabled: rule.enabled,
          target: { boardKey, phaseKey: phase },
          triggered: {
            trigger: { kind: rule.triggerKind, config: rule.triggerConfig },
            action: { kind: rule.actionKind, config: action },
            policyKind: rule.policyKind,
          },
          origin: { kind: 'schedule', generatedName: rule.name },
        },
        rule.createdBy,
        { id: rule.id },
      );
      result.migrated += 1;
    }
    // The rule's own placing route can't match anything any more: the trigger route places its cards.
    result.removedRoutes += await removeRetiredRuleRoutes(boards, scope);
    await fires.copyLegacyFires(rule.id);
    await fires.deleteLegacyRule(rule.id);
  }
  return result;
}

/**
 * Removes a project's routes that read the retired `intake.rule` / `intake.trigger` facts (the
 * routes intake rules made to place their cards). Returns how many it removed.
 */
export async function removeRetiredRuleRoutes(
  boards: Pick<StoredBoardsStorage, 'listIntakeRoutes' | 'deleteIntakeRoute'>,
  scope: { orgId: string; factoryProjectId: string },
): Promise<number> {
  let removed = 0;
  for (const route of (await boards.listIntakeRoutes(scope)).reverse()) {
    if (!namesRetiredRuleFacts(route.when)) continue;
    await boards.deleteIntakeRoute(scope, route.id, { expectedRevision: route.revision });
    removed += 1;
  }
  return removed;
}
