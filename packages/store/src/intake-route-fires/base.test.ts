import { randomUUID } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { PgFactoryStorage } from '@mastra/pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import { IntakeRouteFiresStorage, LEGACY_INTAKE_RULE_FIRES_SCHEMA, LEGACY_INTAKE_RULES_SCHEMA } from './base.ts';

// Set FACTORY_TEST_POSTGRES_URL to a disposable database to also run on PostgreSQL.
const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;

describe.each(['libsql', ...(postgresUrl ? ['postgres'] : [])])('IntakeRouteFiresStorage on %s', backend => {
  async function makeStorage() {
    const storage =
      backend === 'postgres'
        ? new PgFactoryStorage({ id: 'intake-route-fires-test', connectionString: postgresUrl! })
        : new LibSQLFactoryStorage({ id: 'intake-route-fires-test', url: ':memory:' });
    const fires = storage.registerDomain(new IntakeRouteFiresStorage());
    await storage.init();
    onTestFinished(() => storage.close());
    return { fires, scope: { orgId: `org-${randomUUID()}`, factoryProjectId: 'project-1' } };
  }

  const fire = (scope: { orgId: string; factoryProjectId: string }, overrides: Record<string, unknown> = {}) => ({
    ...scope,
    routeId: 'route-1',
    firedAt: new Date('2026-11-16T07:00:00Z'),
    triggerKind: 'schedule',
    outcome: 'done' as const,
    workItemId: null,
    reason: null,
    fireKey: 'schedule:run-1',
    ...overrides,
  });

  it('records a fire once per key and lists a route’s fires newest first', async () => {
    const { fires, scope } = await makeStorage();
    const first = await fires.recordFire(fire(scope));
    expect(await fires.recordFire(fire(scope, { outcome: 'failed' }))).toEqual(first);
    await fires.recordFire(
      fire(scope, { fireKey: 'schedule:run-2', outcome: 'skipped', firedAt: new Date('2026-11-23T07:00:00Z') }),
    );
    const listed = await fires.listFires(scope, 'route-1');
    expect(listed.map(row => row.fireKey)).toEqual(['schedule:run-2', 'schedule:run-1']);
    expect((await fires.lastDoneFire('route-1'))?.fireKey).toBe('schedule:run-1');
    await fires.deleteFires('route-1');
    expect(await fires.listFires(scope, 'route-1')).toEqual([]);
  });

  it('reads the legacy rules and copies their fires once under the rule’s id', async () => {
    const { fires, scope } = await makeStorage();
    const ops = (fires as unknown as { ops: { insertOne: (table: string, row: Record<string, unknown>) => Promise<unknown> } })
      .ops;
    const ruleId = randomUUID();
    await ops.insertOne(LEGACY_INTAKE_RULES_SCHEMA.name, {
      id: ruleId,
      org_id: scope.orgId,
      factory_project_id: scope.factoryProjectId,
      name: 'Security audit',
      trigger_kind: 'schedule',
      trigger_config: { spec: { preset: 'daily', time: '09:00' }, timezone: 'Europe/Kyiv' },
      action_kind: 'create-card',
      action_config: { boardKey: 'audits', phaseKey: null, titleTemplate: 'Аудит', description: '', repository: null },
      policy_kind: 'skip-if-open',
      enabled: true,
      revision: 1,
      created_by: 'user-1',
      created_at: new Date(),
      updated_by: 'user-1',
      updated_at: new Date(),
    });
    await ops.insertOne(LEGACY_INTAKE_RULE_FIRES_SCHEMA.name, {
      id: randomUUID(),
      org_id: scope.orgId,
      factory_project_id: scope.factoryProjectId,
      rule_id: ruleId,
      fired_at: new Date(),
      trigger_kind: 'schedule',
      outcome: 'done',
      work_item_id: 'card-1',
      reason: null,
      fire_key: 'schedule:old',
    });
    const [rule] = (await fires.listLegacyRules()).filter(candidate => candidate.id === ruleId);
    expect(rule).toMatchObject({ name: 'Security audit', policyKind: 'skip-if-open', enabled: true, createdBy: 'user-1' });
    expect(await fires.copyLegacyFires(ruleId)).toBe(1);
    expect(await fires.copyLegacyFires(ruleId)).toBe(0);
    expect((await fires.listFires(scope, ruleId)).map(row => row.workItemId)).toEqual(['card-1']);
    await fires.deleteLegacyRule(ruleId);
    expect((await fires.listLegacyRules()).some(candidate => candidate.id === ruleId)).toBe(false);
  });
});
