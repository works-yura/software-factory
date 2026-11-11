import { describe, expect, it } from 'vitest';

import { intakeRuleRouteCondition } from '@factory/core';
import { createFactoryStorageForTests } from '@factory/testing';

import { INTAKE_RULE_ROUTE_ACTOR, intakeRuleRoutes, routeNamesRule } from './rule-routes.ts';

async function setup() {
  const seed = await createFactoryStorageForTests();
  const project = await seed.projects.create({ orgId: 'org-1', userId: 'admin-1', input: { name: 'Syncta' } });
  const scope = { orgId: 'org-1', factoryProjectId: project.id };
  const rule = await seed.intakeRules.create(
    scope,
    {
      name: 'Security audit',
      triggerKind: 'schedule',
      triggerConfig: { spec: { preset: 'weekly', time: '08:00', weekday: 1 }, timezone: 'Europe/Kyiv' },
      actionKind: 'create-card',
      actionConfig: { boardKey: 'audits', phaseKey: null, titleTemplate: 'Аудит — {date}', description: '', repository: null },
      policyKind: 'skip-if-open',
      enabled: true,
    },
    'admin-1',
  );
  return { seed, scope, rule, routes: intakeRuleRoutes(seed.storedBoards) };
}

describe('intakeRuleRoutes', () => {
  it("adds the rule's own route once, ahead of the catch-all, and removes it with the rule", async () => {
    const { seed, scope, rule, routes } = await setup();

    await routes.ensure(rule, { boardKey: 'audits', phaseKey: null });
    await routes.ensure(rule, { boardKey: 'audits', phaseKey: null });

    const stored = await seed.storedBoards.listIntakeRoutes(scope);
    const own = stored.filter(route => routeNamesRule(route.when, rule.id));
    expect(own).toEqual([
      expect.objectContaining({
        name: 'Розклад · Security audit',
        when: intakeRuleRouteCondition(rule.id),
        target: expect.objectContaining({ boardKey: 'audits', phaseKey: null }),
        createdBy: INTAKE_RULE_ROUTE_ACTOR,
      }),
    ]);
    const catchAll = stored.findIndex(route => route.when === null && route.on.includes('work_item.created'));
    if (catchAll >= 0) expect(stored.indexOf(own[0]!)).toBeLessThan(catchAll);

    await routes.remove(rule);
    expect((await seed.storedBoards.listIntakeRoutes(scope)).some(route => routeNamesRule(route.when, rule.id))).toBe(false);
  });

  it('leaves alone a route a person wrote that names the rule among other conditions', async () => {
    const { seed, scope, rule, routes } = await setup();
    const when = {
      operator: 'AND' as const,
      conditions: [
        { field: 'intake.rule' as const, operator: 'equals' as const, value: rule.id },
        { field: 'item.title' as const, operator: 'contains' as const, value: 'security' },
      ],
    };
    await seed.storedBoards.createIntakeRoute(scope, { name: 'Mine', when, target: { boardKey: 'work', phaseKey: null } }, 'admin-1');

    // It already names the rule: no second route.
    await routes.ensure(rule, { boardKey: 'audits', phaseKey: null });
    expect((await seed.storedBoards.listIntakeRoutes(scope)).filter(route => routeNamesRule(route.when, rule.id))).toHaveLength(1);

    await routes.remove(rule);
    expect((await seed.storedBoards.listIntakeRoutes(scope)).filter(route => routeNamesRule(route.when, rule.id))).toHaveLength(1);
  });
});
