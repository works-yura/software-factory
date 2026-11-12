import { randomUUID } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';

import { IntakeConfigError, intakeKinds } from '@factory/core';
import type { IntakeActionKind, IntakeFireSink, IntakeTriggerKind } from '@factory/core';
import { AuditDomain } from '@factory/feed';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { createDefaultBoardRegistry as createBoardRegistry } from '@factory/pipelines';
import { alwaysPolicy, IntakeTriggerEngine, ProjectBoardCache } from '@factory/runtime';
import {
  AuditStorage,
  FactoryProjectsStorage,
  IntakeRouteFiresStorage,
  StoredBoardsStorage,
  storedTriggerRoute,
  WorkItemsStorage,
} from '@factory/store';

import { IntakeRouteRoutes } from './intake-routes.ts';

const ADMIN = 'admin-user';

/**
 * Test-double kinds, registered only here: they run through the same engine and the same HTTP
 * endpoints as the built-in schedule, which is what makes a new trigger or action one descriptor.
 */
function dummyKinds() {
  let sink: IntakeFireSink | undefined;
  const armed = new Set<string>();
  const notes: string[] = [];
  const trigger: IntakeTriggerKind<{ every: number }> = {
    kind: 'test-ticker',
    label: { uk: 'Тікер', en: 'Ticker' },
    parse: config => {
      const every = (config as { every?: unknown }).every;
      if (typeof every !== 'number' || every < 1) throw new IntakeConfigError('every must be a positive number');
      return { every };
    },
    describe: (config, locale) => (locale === 'uk' ? `кожні ${config.every} хв` : `every ${config.every} min`),
    nextFires: (config, after, count) =>
      Array.from({ length: count }, (_, index) => new Date(after.getTime() + (index + 1) * config.every * 60_000)),
    start: next => {
      sink = next;
    },
    arm: async route => void armed.add(route.id),
    disarm: async routeId => void armed.delete(routeId),
  };
  const action: IntakeActionKind<{ text: string }> = {
    kind: 'test-note',
    label: { uk: 'Нотатка', en: 'Note' },
    parse: config => ({ text: String((config as { text?: unknown }).text ?? '') }),
    describe: config => `note "${config.text}"`,
    run: async ({ route, config }) => {
      notes.push(`${route.name}: ${config.text}`);
      return { workItemId: null };
    },
  };
  return { trigger, action, armed, notes, fire: (...args: Parameters<IntakeFireSink>) => sink!(...args) };
}

async function setup() {
  const storage = new LibSQLFactoryStorage({ id: `intake-triggers-${randomUUID()}`, url: ':memory:' });
  const domains = {
    projects: storage.registerDomain(new FactoryProjectsStorage()),
    workItems: storage.registerDomain(new WorkItemsStorage()),
    boards: storage.registerDomain(new StoredBoardsStorage()),
    audit: storage.registerDomain(new AuditStorage()),
    fires: storage.registerDomain(new IntakeRouteFiresStorage()),
  };
  await storage.init();
  onTestFinished(() => storage.close());
  const orgId = `org-${randomUUID()}`;
  const project = await domains.projects.create({ orgId, userId: ADMIN, input: { name: 'Acme' } });
  const base = `/web/factory/projects/${project.id}/intake-routes`;
  const kinds = dummyKinds();
  const engine = new IntakeTriggerEngine({
    routes: {
      getTriggerRoute: async id => {
        const route = await domains.boards.findIntakeRouteById(id);
        return route ? storedTriggerRoute(route) : null;
      },
      listTriggerRoutes: async () => (await domains.boards.listTriggerRoutes()).flatMap(route => storedTriggerRoute(route) ?? []),
      recordFire: input => domains.fires.recordFire(input),
      findFire: (routeId, key) => domains.fires.findFire(routeId, key),
      listFires: (scope, routeId, options) => domains.fires.listFires(scope, routeId, options),
      lastDoneFire: routeId => domains.fires.lastDoneFire(routeId),
      claimFire: (route, holder, until) => domains.boards.claimIntakeRouteFire(route, route.id, holder, until),
      releaseFire: (route, holder) => domains.boards.releaseIntakeRouteFire(route, route.id, holder),
    },
    kinds: intakeKinds({ triggers: [kinds.trigger], actions: [kinds.action], policies: [alwaysPolicy] }),
    now: () => new Date('2026-11-16T07:00:00Z'),
    logger: { warn: () => {} },
  });
  await engine.start();
  const cache = new ProjectBoardCache({
    codeRegistry: createBoardRegistry(),
    storage: domains.boards,
    projects: domains.projects,
    recheckMs: 1000,
    now: () => 0,
    warn: () => {},
  });
  const auth = fakeRouteAuth({ isOrganizationAdmin: async (_org, userId) => userId === ADMIN });
  const app = new Hono();
  const caller = { id: ADMIN };
  app.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, { id: caller.id, organizationId: orgId } as never);
    await next();
  });
  mountApiRoutes(app, [
    ...new IntakeRouteRoutes({
      auth,
      audit: new AuditDomain({ auth, audit: domains.audit, projects: domains.projects }),
      projects: domains.projects,
      storage: domains.boards,
      boards: cache,
      triggers: { engine, fires: domains.fires, cards: domains.workItems },
    }).routes(),
  ]);
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { send, base, kinds, caller, domains, scope: { orgId, factoryProjectId: project.id } };
}

const TICKER_ROUTE = {
  name: 'Ticker',
  target: { boardKey: 'audits', phaseKey: 'intake' },
  triggered: {
    trigger: { kind: 'test-ticker', config: { every: 30 } },
    action: { kind: 'test-note', config: { text: 'hello' } },
    policy: { kind: 'always' },
  },
};

describe('routes with a trigger of their own, over HTTP', () => {
  it('lists the kinds and previews a trigger before anything is saved', async () => {
    const { send, base } = await setup();
    const kinds = await send('GET', `${base}/kinds?locale=uk`);
    expect(kinds.status).toBe(200);
    expect(kinds.body.triggers).toEqual([{ kind: 'test-ticker', label: 'Тікер' }]);
    expect(kinds.body.placeholders).toContain('{route}');
    const preview = await send('POST', `${base}/preview`, { trigger: { kind: 'test-ticker', config: { every: 30 } }, locale: 'en' });
    expect(preview.body).toEqual({
      summary: 'every 30 min',
      nextFires: ['2026-11-16T07:30:00.000Z', '2026-11-16T08:00:00.000Z', '2026-11-16T08:30:00.000Z'],
      problems: [],
    });
  });

  it('adds a dummy-trigger route into the same list, arms it, fires it, shows its history, and stops it on delete', async () => {
    const { send, base, kinds, scope } = await setup();
    const created = await send('POST', `${base}?locale=en`, TICKER_ROUTE);
    expect(created.status).toBe(201);
    const route = created.body.intakeRoute;
    expect(route).toMatchObject({
      name: 'Ticker',
      on: [],
      when: null,
      triggered: {
        trigger: { kind: 'test-ticker', summary: 'every 30 min' },
        action: { kind: 'test-note', summary: 'note "hello"' },
        policy: { kind: 'always' },
        lastFire: null,
      },
      problems: [],
    });
    expect(route.triggered.nextFires).toHaveLength(3);
    expect(kinds.armed.has(route.id)).toBe(true);
    // The same list holds the plain routes and this one.
    const list = await send('GET', base);
    expect(list.body.intakeRoutes.map((one: { id: string }) => one.id)).toContain(route.id);

    await kinds.fire({ routeId: route.id, firedAt: new Date('2026-11-16T07:30:00Z'), triggerKind: 'test-ticker', fireKey: 'tick-1' });
    expect(kinds.notes).toEqual(['Ticker: hello']);
    const fires = await send('GET', `${base}/${route.id}/fires`);
    expect(fires.body.fires).toEqual([expect.objectContaining({ outcome: 'done', triggerKind: 'test-ticker', workItemId: null })]);

    const paused = await send('PATCH', `${base}/${route.id}`, { enabled: false, expectedRevision: route.revision });
    expect(paused.status).toBe(200);
    expect(kinds.armed.has(route.id)).toBe(false);

    const removed = await send('DELETE', `${base}/${route.id}?expectedRevision=${paused.body.intakeRoute.revision}`);
    expect(removed.status).toBe(204);
    expect((await send('GET', `${base}/${route.id}/fires`)).status).toBe(404);
    expect(scope.orgId).toBeTruthy();
  });

  it('refuses a trigger config that does not fit, an unknown kind, and a condition on a trigger route', async () => {
    const { send, base } = await setup();
    const bad = await send('POST', base, {
      ...TICKER_ROUTE,
      triggered: { ...TICKER_ROUTE.triggered, trigger: { kind: 'test-ticker', config: { every: 0 } } },
    });
    expect(bad).toMatchObject({ status: 422, body: { error: 'invalid_intake_route', reason: 'invalid_config' } });
    const unknown = await send('POST', base, {
      ...TICKER_ROUTE,
      triggered: { ...TICKER_ROUTE.triggered, action: { kind: 'nope', config: {} } },
    });
    expect(unknown).toMatchObject({ status: 422, body: { reason: 'unknown_kind' } });
    const conditioned = await send('POST', base, {
      ...TICKER_ROUTE,
      when: { operator: 'AND', conditions: [{ field: 'item.labels', operator: 'contains', value: 'x' }] },
    });
    expect(conditioned.status).toBe(422);
  });
});

describe('running a route «За розкладом» now, over HTTP', () => {
  it('fires the route once through its own action, recorded as started by the admin', async () => {
    const { send, base, kinds } = await setup();
    const route = (await send('POST', base, TICKER_ROUTE)).body.intakeRoute;
    const fired = await send('POST', `${base}/${route.id}/fire`);
    expect(fired.status).toBe(200);
    expect(fired.body.fire).toMatchObject({ outcome: 'done', triggerKind: 'test-ticker', triggeredBy: ADMIN, workItemId: null });
    expect(kinds.notes).toEqual(['Ticker: hello']);
    const history = await send('GET', `${base}/${route.id}/fires`);
    expect(history.body.fires).toEqual([expect.objectContaining({ id: fired.body.fire.id, triggeredBy: ADMIN })]);
    // The trigger's own fire is not marked as manual.
    await kinds.fire({ routeId: route.id, firedAt: new Date('2026-11-16T07:30:00Z'), triggerKind: 'test-ticker', fireKey: 'tick-1' });
    const after = await send('GET', `${base}/${route.id}/fires`);
    expect(after.body.fires.map((fire: { triggeredBy: string | null }) => fire.triggeredBy).sort()).toEqual([ADMIN, null]);
  });

  it('refuses a non-admin (403), a switched-off route (409), a route without a schedule (422) and an unknown one (404)', async () => {
    const { send, base, kinds, caller } = await setup();
    const route = (await send('POST', base, TICKER_ROUTE)).body.intakeRoute;
    caller.id = 'member-user';
    expect(await send('POST', `${base}/${route.id}/fire`)).toMatchObject({
      status: 403,
      body: { error: 'organization_admin_required' },
    });
    caller.id = ADMIN;
    const paused = await send('PATCH', `${base}/${route.id}`, { enabled: false, expectedRevision: route.revision });
    expect(paused.status).toBe(200);
    expect(await send('POST', `${base}/${route.id}/fire`)).toMatchObject({
      status: 409,
      body: { error: 'intake_route_disabled', message: expect.stringMatching(/switched off/) },
    });
    const plain = await send('POST', base, { name: 'Plain', target: { boardKey: 'audits', phaseKey: 'intake' } });
    expect(plain.status).toBe(201);
    expect(await send('POST', `${base}/${plain.body.intakeRoute.id}/fire`)).toMatchObject({
      status: 422,
      body: { error: 'intake_route_not_scheduled', message: expect.stringMatching(/За розкладом/) },
    });
    expect((await send('POST', `${base}/${randomUUID()}/fire`)).status).toBe(404);
    expect(kinds.notes).toEqual([]);
  });
});
