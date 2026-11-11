/**
 * The adapter behind `IntakeRuleRoutes`: a rule that files cards gets its own intake route in the
 * stored routes of its project («Розклад · <name>» → its board › phase), placed just ahead of the
 * catch-all like any new route. Routes stay the one place that decides where a card goes; the route
 * is a person's to edit or move afterwards.
 */

import { intakeRuleRouteCondition } from '@factory/core';
import type { IntakeRuleRecord, IntakeRuleRoutes, RuleGroup } from '@factory/core';
import type { StoredBoardsStorage } from '@factory/store';

/** Who the rules' own routes are attributed to in their history. */
export const INTAKE_RULE_ROUTE_ACTOR = 'system:intake-rule-route';

/** Whether a route's condition names the rule, anywhere in it. */
export function routeNamesRule(when: RuleGroup | null, ruleId: string): boolean {
  if (!when) return false;
  return when.conditions.some(member =>
    'conditions' in member
      ? routeNamesRule(member, ruleId)
      : member.field === 'intake.rule' && member.operator === 'equals' && member.value === ruleId,
  );
}

export function intakeRuleRoutes(
  boards: Pick<StoredBoardsStorage, 'listIntakeRoutes' | 'createIntakeRoute' | 'deleteIntakeRoute'>,
): IntakeRuleRoutes {
  const scopeOf = (rule: IntakeRuleRecord) => ({ orgId: rule.orgId, factoryProjectId: rule.factoryProjectId });
  return {
    async ensure(rule, target) {
      const routes = await boards.listIntakeRoutes(scopeOf(rule));
      if (routes.some(route => routeNamesRule(route.when, rule.id))) return;
      await boards.createIntakeRoute(
        scopeOf(rule),
        { name: `Розклад · ${rule.name}`, when: intakeRuleRouteCondition(rule.id), target },
        INTAKE_RULE_ROUTE_ACTOR,
      );
    },
    async remove(rule) {
      const own = JSON.stringify(intakeRuleRouteCondition(rule.id));
      for (const route of await boards.listIntakeRoutes(scopeOf(rule))) {
        if (JSON.stringify(route.when) !== own) continue;
        await boards.deleteIntakeRoute(scopeOf(rule), route.id, { expectedRevision: route.revision });
      }
    },
  };
}
