import { randomUUID } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { PgFactoryStorage } from '@mastra/pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import { IntakeRulesStorage } from './base.ts';
import type { IntakeRuleInput } from './base.ts';

// Set FACTORY_TEST_POSTGRES_URL to a disposable database to also run on PostgreSQL.
const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;

describe.each(['libsql', ...(postgresUrl ? ['postgres'] : [])])('IntakeRulesStorage on %s', backend => {
  async function makeStorage() {
    const storage =
      backend === 'postgres'
        ? new PgFactoryStorage({ id: 'intake-rules-test', connectionString: postgresUrl! })
        : new LibSQLFactoryStorage({ id: 'intake-rules-test', url: ':memory:' });
    const rules = storage.registerDomain(new IntakeRulesStorage());
    await storage.init();
    onTestFinished(() => storage.close());
    return { rules, scope: { orgId: `org-${randomUUID()}`, factoryProjectId: 'project-1' } };
  }

  const input = (overrides: Partial<IntakeRuleInput> = {}): IntakeRuleInput => ({
    name: 'Security audit',
    triggerKind: 'schedule',
    triggerConfig: { spec: { preset: 'weekly', time: '08:00', weekday: 1 }, timezone: 'Europe/Kyiv' },
    actionKind: 'create-card',
    actionConfig: { boardKey: 'audits', titleTemplate: 'Аудит безпеки — {date}', description: 'Check secrets.' },
    policyKind: 'skip-if-open',
    enabled: true,
    ...overrides,
  });

  it('keeps any kind’s config as given, apart from other orgs and projects', async () => {
    const { rules, scope } = await makeStorage();
    const created = await rules.create(scope, input(), 'user-1');
    await rules.create({ ...scope, orgId: `other-${scope.orgId}` }, input({ triggerKind: 'webhook', triggerConfig: { path: 'x' } }), 'user-2');

    expect(await rules.list(scope)).toEqual([
      expect.objectContaining({
        id: created.id,
        triggerKind: 'schedule',
        triggerConfig: { spec: { preset: 'weekly', time: '08:00', weekday: 1 }, timezone: 'Europe/Kyiv' },
        actionKind: 'create-card',
        actionConfig: expect.objectContaining({ boardKey: 'audits' }),
        policyKind: 'skip-if-open',
        enabled: true,
        revision: 1,
        createdBy: 'user-1',
      }),
    ]);
    expect(await rules.getById(created.id)).toMatchObject({ orgId: scope.orgId });
    expect(await rules.get({ ...scope, factoryProjectId: 'project-2' }, created.id)).toBeNull();
  });

  it('updates at the expected revision and refuses a stale edit', async () => {
    const { rules, scope } = await makeStorage();
    const created = await rules.create(scope, input(), 'user-1');
    expect(await rules.update(scope, created.id, { enabled: false }, { expectedRevision: 1, actor: 'user-2' })).toMatchObject({
      enabled: false,
      revision: 2,
      updatedBy: 'user-2',
    });
    await expect(rules.update(scope, created.id, { name: 'x' }, { expectedRevision: 1, actor: 'u' })).rejects.toMatchObject({
      code: 'intake_rule_conflict',
    });
    await expect(rules.update(scope, randomUUID(), { name: 'x' }, { expectedRevision: 1, actor: 'u' })).rejects.toMatchObject({
      code: 'intake_rule_not_found',
    });
  });

  it('logs fires newest first, finds the last card made, and drops the log with the rule', async () => {
    const { rules, scope } = await makeStorage();
    const rule = await rules.create(scope, input(), 'user-1');
    const fire = { ...scope, ruleId: rule.id, triggerKind: 'schedule' };
    await rules.recordFire({ ...fire, firedAt: new Date(1000), outcome: 'done', workItemId: 'card-1', reason: null });
    await rules.recordFire({ ...fire, firedAt: new Date(2000), outcome: 'done', workItemId: null, reason: null });
    await rules.recordFire({ ...fire, firedAt: new Date(3000), outcome: 'skipped', workItemId: null, reason: 'open' });
    await rules.recordFire({ ...fire, firedAt: new Date(4000), outcome: 'failed', workItemId: null, reason: 'boom' });

    expect((await rules.listFires(scope, rule.id)).map(f => f.outcome)).toEqual(['failed', 'skipped', 'done', 'done']);
    expect(await rules.lastFireWithWorkItem(rule.id)).toMatchObject({ workItemId: 'card-1' });

    await rules.delete(scope, rule.id, { expectedRevision: 1 });
    expect(await rules.list(scope)).toEqual([]);
    expect(await rules.listFires(scope, rule.id)).toEqual([]);
  });
});
