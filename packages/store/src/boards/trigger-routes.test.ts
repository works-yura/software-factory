import { randomUUID } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { StoredBoardError, StoredBoardsStorage } from './base.ts';
import type { StoredIntakeRouteInput } from './base.ts';

const SCHEDULE = {
  trigger: { kind: 'schedule', config: { spec: { preset: 'weekly', time: '09:00', weekday: 1 }, timezone: 'Europe/Kyiv' } },
  action: { kind: 'create-card', config: { titleTemplate: 'Аудит безпеки — {date}', description: 'Check.', repository: null } },
  policyKind: 'skip-if-open',
};

function scheduleRoute(overrides: Partial<StoredIntakeRouteInput> = {}): StoredIntakeRouteInput {
  return {
    name: 'Аудит безпеки',
    target: { boardKey: 'audits', phaseKey: 'intake' },
    triggered: SCHEDULE,
    origin: { kind: 'schedule', generatedName: 'Аудит безпеки' },
    ...overrides,
  };
}

describe('trigger routes', () => {
  async function setup() {
    const storage = new LibSQLFactoryStorage({ id: `trigger-routes-${randomUUID()}`, url: ':memory:' });
    const boards = storage.registerDomain(new StoredBoardsStorage());
    await storage.init();
    onTestFinished(() => storage.close());
    return { boards, scope: { orgId: `org-${randomUUID()}`, factoryProjectId: 'project-1' } };
  }

  it('keeps a schedule route in the same list, with its trigger, action and policy, outside first-match placement', async () => {
    const { boards, scope } = await setup();
    const created = await boards.createIntakeRoute(scope, scheduleRoute(), 'user-1');
    expect(created).toMatchObject({
      on: [],
      when: null,
      trigger: SCHEDULE.trigger,
      action: SCHEDULE.action,
      policyKind: 'skip-if-open',
      origin: { kind: 'schedule', generatedName: 'Аудит безпеки' },
      target: { boardKey: 'audits', phaseKey: 'intake', joinClosedIssue: false },
    });
    const routes = await boards.listIntakeRoutes(scope);
    // Appended after the catch-all: a trigger route never takes arriving cards, so order doesn't matter to it.
    expect(routes.at(-1)?.id).toBe(created.id);
    expect((await boards.listTriggerRoutes()).map(route => route.id)).toContain(created.id);
    expect(await boards.findIntakeRouteById(created.id)).toMatchObject({ factoryProjectId: 'project-1' });
    // Plain routes stay plain.
    expect(routes.filter(route => route.trigger !== null).map(route => route.id)).toEqual([created.id]);
  });

  it('refuses events or a condition on a trigger route', async () => {
    const { boards, scope } = await setup();
    await expect(
      boards.createIntakeRoute(scope, scheduleRoute({ on: ['work_item.created'] }), 'user-1'),
    ).rejects.toBeInstanceOf(StoredBoardError);
    await expect(
      boards.createIntakeRoute(
        scope,
        scheduleRoute({ when: { operator: 'AND', conditions: [{ field: 'item.labels', operator: 'contains', value: 'x' }] } }),
        'user-1',
      ),
    ).rejects.toBeInstanceOf(StoredBoardError);
  });

  it('writes a route with a fixed id once, however often a migration runs', async () => {
    const { boards, scope } = await setup();
    const id = randomUUID();
    const first = await boards.createIntakeRoute(scope, scheduleRoute(), 'system', { id });
    const again = await boards.createIntakeRoute(scope, scheduleRoute({ name: 'other' }), 'system', { id });
    expect(again).toEqual(first);
    expect((await boards.listIntakeRoutes(scope)).filter(route => route.id === id)).toHaveLength(1);
  });

  it('edits a trigger route’s schedule and turns it back into a plain route', async () => {
    const { boards, scope } = await setup();
    const created = await boards.createIntakeRoute(scope, scheduleRoute(), 'user-1');
    const daily = { ...SCHEDULE, trigger: { kind: 'schedule', config: { spec: { preset: 'daily', time: '08:00' }, timezone: 'UTC' } } };
    const edited = await boards.updateIntakeRoute(scope, created.id, { triggered: daily }, {
      expectedRevision: created.revision,
      actor: 'user-1',
    });
    expect(edited.trigger).toEqual(daily.trigger);
    const plain = await boards.updateIntakeRoute(
      scope,
      created.id,
      { triggered: null, on: ['work_item.created'] },
      { expectedRevision: edited.revision, actor: 'user-1' },
    );
    expect(plain).toMatchObject({ trigger: null, action: null, policyKind: null, on: ['work_item.created'] });
  });
});
