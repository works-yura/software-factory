import { describe, expect, it, vi } from 'vitest';

import { externalSourceForWorkItem, INTAKE_ROUTE_ORIGIN_METADATA_KEY } from '@factory/core';
import {
  createBoardRegistry,
  createFactoryStorageForTests,
  FactoryDecisionDispatcher,
  FactoryTransitionService,
} from '@factory/testing';
import { storedTriggerRoute } from '@factory/store';
import type { StoredIntakeRouteInput, StoredIntakeRouteRecord } from '@factory/store';

import { migrateLegacyIntakeRules } from './migrations.ts';
import { intakeTriggerRouteRepository, writeFireCardBack } from './repository.ts';
import { INTAKE_ROUTE_FIRE_WORKFLOW_ID, intakeRouteScheduleId, legacyIntakeRuleScheduleId } from './schedule-trigger.ts';
import type { ScheduleRows } from './schedule-trigger.ts';
import { setupIntakeTriggers } from './setup.ts';

/** Core `Schedules` as far as the trigger uses it: rows in a map. */
function fakeSchedules() {
  const rows = new Map<string, Record<string, unknown>>();
  const schedules = {
    get: async (id: string) => (rows.get(id) as never) ?? null,
    create: async (input: Record<string, unknown>) => {
      const row = { ...input, status: input.status ?? 'active' };
      rows.set(input.id as string, row);
      return row as never;
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const row = { ...rows.get(id), ...patch };
      rows.set(id, row);
      return row as never;
    },
    pause: async (id: string) => rows.set(id, { ...rows.get(id), status: 'paused' }).get(id) as never,
    resume: async (id: string) => rows.set(id, { ...rows.get(id), status: 'active' }).get(id) as never,
    delete: async (id: string) => void rows.delete(id),
  } satisfies ScheduleRows;
  return { rows, schedules };
}

const SECURITY = {
  trigger: { kind: 'schedule', config: { spec: { preset: 'weekly', time: '08:00', weekday: 1 }, timezone: 'Europe/Kyiv' } },
  action: {
    kind: 'create-card',
    config: {
      titleTemplate: 'Аудит безпеки — {date}',
      description: 'Аудит: security. Route {route}, fired {date} {time}.',
      repository: null,
    },
  },
  policyKind: 'skip-if-open',
};

async function setup(options: { cardWaitMs?: number } = {}) {
  const seed = await createFactoryStorageForTests();
  const project = await seed.projects.create({ orgId: 'org-1', userId: 'admin-1', input: { name: 'Syncta' } });
  const scope = { orgId: 'org-1', factoryProjectId: project.id };
  const boards = createBoardRegistry();
  let clock = new Date('2026-11-16T06:00:00Z');
  const { rows, schedules } = fakeSchedules();
  const { engine, workflows } = setupIntakeTriggers({
    routes: intakeTriggerRouteRepository(seed.storedBoards, seed.intakeRouteFires),
    now: () => clock,
    logger: { warn: () => {} },
    schedule: { schedules: () => schedules, now: () => clock },
    cards: {
      workItems: seed.workItems,
      reader: seed.workItems,
      boards: { load: async () => boards },
      configVersion: 'test-v1',
      now: () => clock,
      ...(options.cardWaitMs ? { cardWaitMs: options.cardWaitMs, cardPollMs: 10 } : {}),
    },
    fireLock: { waitMs: 10_000, pollMs: 10 },
  });
  await engine.start();
  const dispatcher = new FactoryDecisionDispatcher({
    harness: { getSession: vi.fn(async () => undefined) } as never,
    transitionService: new FactoryTransitionService({ storage: seed.workItems, configVersion: 'test-v1', boards }),
    storage: seed.workItems,
    boards,
    intakeRoutes: seed.storedBoards,
    ownerId: 'worker-1',
    cardFiled: writeFireCardBack(seed.intakeRouteFires),
  });
  const dispatch = async () => {
    for (let pass = 0; pass < 3; pass++) await dispatcher.runOnce(new Date(clock.getTime() + 60_000 * (pass + 1)));
  };
  const add = async (overrides: Partial<StoredIntakeRouteInput> = {}) => {
    const input: StoredIntakeRouteInput = {
      name: 'Security audit',
      target: { boardKey: 'audits', phaseKey: 'intake' },
      triggered: SECURITY,
      ...overrides,
    };
    const trigger = storedTriggerRoute({ ...(await seed.storedBoards.createIntakeRoute(scope, input, 'admin-1')) });
    await engine.validate(trigger!, scope);
    await engine.sync(trigger!);
    return trigger!;
  };
  /** Runs the fire workflow the way core's scheduler does when the route's row comes due. */
  const fireSchedule = async (routeId: string, claimId: string) => {
    const row = rows.get(intakeRouteScheduleId(routeId));
    if (!row) throw new Error('no schedule row');
    const run = await workflows[INTAKE_ROUTE_FIRE_WORKFLOW_ID]!.createRun({ runId: claimId });
    const result = await run.start({ inputData: row.inputData as { routeId: string } });
    expect(result.status).toBe('success');
    return (await seed.intakeRouteFires.findFire(routeId, `schedule:${claimId}`))!;
  };
  const card = (routeId: string, claimId: string) =>
    seed.workItems.getByProjectSource({
      ...scope,
      source: externalSourceForWorkItem('intake-route', `${routeId}:schedule:${claimId}`),
    });
  /** The dispatcher as the server runs it: woken all the time, filing cards while fires wait for them. */
  const dispatchInBackground = () => {
    let running = true;
    const loop = (async () => {
      let pass = 0;
      while (running) {
        await dispatcher.runOnce(new Date(clock.getTime() + 60_000 * ++pass));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })();
    return async () => {
      running = false;
      await loop;
    };
  };
  return {
    seed,
    scope,
    engine,
    rows,
    schedules,
    add,
    fireSchedule,
    dispatch,
    dispatchInBackground,
    card,
    setClock: (at: string) => (clock = new Date(at)),
  };
}

describe('a route «За розкладом» files its own cards', () => {
  it('arms a core schedule row per route and follows pause and edits', async () => {
    const { seed, scope, engine, rows, add } = await setup();
    const route = await add();
    expect(rows.get(intakeRouteScheduleId(route.id))).toMatchObject({
      workflowId: INTAKE_ROUTE_FIRE_WORKFLOW_ID,
      cron: '0 8 * * 1',
      timezone: 'Europe/Kyiv',
      inputData: { routeId: route.id },
    });
    const stored = (await seed.storedBoards.getIntakeRoute(scope, route.id)) as StoredIntakeRouteRecord;
    const paused = await seed.storedBoards.updateIntakeRoute(scope, route.id, { enabled: false }, { expectedRevision: stored.revision, actor: 'admin-1' });
    await engine.sync(storedTriggerRoute(paused)!);
    expect(rows.has(intakeRouteScheduleId(route.id))).toBe(false);
  });

  it('files the card at the route’s own target, dated in its timezone, once per claim, ahead of any catch-all', async () => {
    const { route, fire, card, seed, scope, dispatch } = await (async () => {
      const ctx = await setup();
      const route = await ctx.add();
      const fire = await ctx.fireSchedule(route.id, 'claim-1');
      // Redelivered by the scheduler under the same claim: recorded and filed once.
      expect(await ctx.fireSchedule(route.id, 'claim-1')).toEqual(fire);
      return { ...ctx, route, fire };
    })();
    expect(fire).toMatchObject({ outcome: 'done', triggerKind: 'schedule', fireKey: 'schedule:claim-1' });
    await dispatch();
    const filed = await card(route.id, 'claim-1');
    expect(filed).toMatchObject({ title: 'Аудит безпеки — 2026-11-16', board: 'audits', stages: ['intake'] });
    expect(filed!.metadata?.[INTAKE_ROUTE_ORIGIN_METADATA_KEY]).toMatchObject({ id: route.id, fireKey: 'schedule:claim-1' });
    expect(filed!.metadata?.description).toBe('Аудит: security. Route Security audit, fired 2026-11-16 08:00.');
    expect((await seed.workItems.listShared(scope)).filter(item => item.board === 'audits')).toHaveLength(1);
    // The fire names the card it filed, written back once the dispatcher filed it.
    expect((await seed.intakeRouteFires.findFire(route.id, 'schedule:claim-1'))?.workItemId).toBe(filed!.id);
  });

  it('skips a fire while the last card is open and files again once it is done', async () => {
    const ctx = await setup();
    const route = await ctx.add();
    await ctx.fireSchedule(route.id, 'claim-1');
    await ctx.dispatch();
    expect(await ctx.fireSchedule(route.id, 'claim-2')).toMatchObject({ outcome: 'skipped' });
    const first = (await ctx.card(route.id, 'claim-1'))!;
    await ctx.seed.workItems.update({ orgId: 'org-1', id: first.id, userId: 'admin-1', patch: { stages: ['done'] } });
    expect(await ctx.fireSchedule(route.id, 'claim-3')).toMatchObject({ outcome: 'done' });
  });

  it('records a fire it cannot carry out as failed, with the reason', async () => {
    const ctx = await setup();
    const route = await ctx.add();
    const stored = (await ctx.seed.storedBoards.getIntakeRoute(ctx.scope, route.id))!;
    await ctx.seed.storedBoards.updateIntakeRoute(
      ctx.scope,
      route.id,
      { target: { boardKey: 'gone' } },
      { expectedRevision: stored.revision, actor: 'admin-1' },
    );
    expect(await ctx.fireSchedule(route.id, 'claim-1')).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/gone/) });
  });
});

describe('running a route «За розкладом» now («Запустити зараз»)', () => {
  it('files the card like a scheduled fire, dated now, and records the fire as started by the person', async () => {
    const ctx = await setup({ cardWaitMs: 5_000 });
    const route = await ctx.add();
    ctx.setClock('2026-11-18T13:05:00Z');
    const stop = ctx.dispatchInBackground();
    const fire = (await ctx.engine.fireNow(route, 'admin-1'))!;
    await stop();
    expect(fire).toMatchObject({ outcome: 'done', triggerKind: 'schedule', triggeredBy: 'admin-1', firedAt: new Date('2026-11-18T13:05:00Z') });
    expect(fire.fireKey).toMatch(/^manual:/);
    // The fire waited for its card, so it names it already.
    const card = (await ctx.seed.workItems.getByProjectSource({
      ...ctx.scope,
      source: externalSourceForWorkItem('intake-route', `${route.id}:${fire.fireKey}`),
    }))!;
    expect(fire.workItemId).toBe(card.id);
    expect(card).toMatchObject({ title: 'Аудит безпеки — 2026-11-18', board: 'audits', stages: ['intake'] });
    expect(card.metadata?.description).toBe('Аудит: security. Route Security audit, fired 2026-11-18 15:05.');
    expect(card.metadata?.[INTAKE_ROUTE_ORIGIN_METADATA_KEY]).toMatchObject({
      id: route.id,
      triggerKind: 'schedule',
      firedAt: '2026-11-18T13:05:00.000Z',
      fireKey: fire.fireKey,
      triggeredBy: 'admin-1',
    });
    expect(await ctx.seed.intakeRouteFires.listFires(ctx.scope, route.id)).toEqual([
      expect.objectContaining({ id: fire.id, triggeredBy: 'admin-1', workItemId: card.id }),
    ]);
  });

  it('is held back by skip-if-open like a scheduled fire, naming the open card', async () => {
    const ctx = await setup();
    const route = await ctx.add();
    await ctx.fireSchedule(route.id, 'claim-1');
    await ctx.dispatch();
    const open = (await ctx.card(route.id, 'claim-1'))!;
    expect(await ctx.engine.fireNow(route, 'admin-1')).toMatchObject({
      outcome: 'skipped',
      triggeredBy: 'admin-1',
      workItemId: open.id,
      reason: expect.stringMatching(/still open/),
    });
  });

  it('never double-files when the schedule and a person fire the route at the same moment', async () => {
    const ctx = await setup({ cardWaitMs: 5_000 });
    const route = await ctx.add();
    const stop = ctx.dispatchInBackground();
    const [scheduled, byHand] = await Promise.all([ctx.fireSchedule(route.id, 'claim-1'), ctx.engine.fireNow(route, 'admin-1')]);
    await stop();
    expect([scheduled.outcome, byHand!.outcome].sort()).toEqual(['done', 'skipped']);
    const done = scheduled.outcome === 'done' ? scheduled : byHand!;
    const skipped = scheduled.outcome === 'done' ? byHand! : scheduled;
    expect(skipped.workItemId).toBe(done.workItemId);
    expect((await ctx.seed.workItems.listShared(ctx.scope)).filter(item => item.board === 'audits')).toHaveLength(1);
  });
});

describe('migrating intake rules into routes', () => {
  it('turns each rule into a trigger route with its id, creator and fires, drops its paired route, once', async () => {
    const ctx = await setup();
    const ops = (ctx.seed.intakeRouteFires as unknown as { ops: { insertOne(t: string, r: Record<string, unknown>): Promise<unknown> } }).ops;
    const ruleId = '0a5f2130-0000-4000-8000-000000000001';
    await ops.insertOne('factory_intake_rules', {
      id: ruleId,
      org_id: 'org-1',
      factory_project_id: ctx.scope.factoryProjectId,
      name: 'Аудит безпеки',
      trigger_kind: 'schedule',
      trigger_config: SECURITY.trigger.config,
      action_kind: 'create-card',
      action_config: { boardKey: 'audits', phaseKey: 'scheduled', ...SECURITY.action.config },
      policy_kind: 'skip-if-open',
      enabled: true,
      revision: 3,
      created_by: 'user-7',
      created_at: new Date(),
      updated_by: 'user-7',
      updated_at: new Date(),
    });
    await ops.insertOne('factory_intake_rule_fires', {
      id: '0a5f2130-0000-4000-8000-0000000000f1',
      org_id: 'org-1',
      factory_project_id: ctx.scope.factoryProjectId,
      rule_id: ruleId,
      fired_at: new Date(),
      trigger_kind: 'schedule',
      outcome: 'done',
      work_item_id: null,
      reason: null,
      fire_key: 'schedule:old',
    });
    await ctx.seed.storedBoards.createIntakeRoute(
      ctx.scope,
      {
        name: 'Розклад · Аудит безпеки',
        when: { operator: 'AND', conditions: [{ field: 'intake.rule' as never, operator: 'equals', value: ruleId }] },
        target: { boardKey: 'audits' },
      },
      'system:intake-rule-route',
    );
    const run = () =>
      migrateLegacyIntakeRules({
        fires: ctx.seed.intakeRouteFires,
        boards: ctx.seed.storedBoards,
        renames: { audits: { scheduled: 'intake' } },
      });
    expect(await run()).toEqual({ migrated: 1, removedRoutes: 1 });
    expect(await run()).toEqual({ migrated: 0, removedRoutes: 0 });
    const routes = await ctx.seed.storedBoards.listIntakeRoutes(ctx.scope);
    expect(routes.filter(route => route.name.startsWith('Розклад ·'))).toEqual([]);
    const route = routes.find(candidate => candidate.id === ruleId)!;
    expect(route).toMatchObject({
      name: 'Аудит безпеки',
      createdBy: 'user-7',
      target: { boardKey: 'audits', phaseKey: 'intake' },
      trigger: SECURITY.trigger,
      action: { kind: 'create-card', config: SECURITY.action.config },
      policyKind: 'skip-if-open',
      origin: { kind: 'schedule', generatedName: 'Аудит безпеки' },
    });
    expect((await ctx.seed.intakeRouteFires.listFires(ctx.scope, ruleId)).map(fire => fire.fireKey)).toEqual(['schedule:old']);
    // The rule's old schedule row goes when its route is armed: nothing fires the retired workflow.
    ctx.rows.set(legacyIntakeRuleScheduleId(ruleId), { id: legacyIntakeRuleScheduleId(ruleId) });
    await ctx.engine.armAll();
    expect(ctx.rows.has(legacyIntakeRuleScheduleId(ruleId))).toBe(false);
    expect(ctx.rows.has(intakeRouteScheduleId(ruleId))).toBe(true);
  });
});
