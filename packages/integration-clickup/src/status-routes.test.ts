import { describe, expect, it } from 'vitest';

import { createBoardRegistry, defineBoard, routeSubscribesSource } from '@factory/core';
import type { IntakeRoute, RuleGroup } from '@factory/core';

import { readClickUpSettings } from './settings.ts';
import {
  listStatusCondition,
  migrateListStatusRules,
  STATUS_ROUTE_MIGRATION_ACTOR,
  statusRouteId,
  statusRouteParts,
} from './status-routes.ts';

const registry = createBoardRegistry({
  boards: [
    defineBoard({
      id: 'work',
      title: 'Work',
      initialPhase: 'intake',
      phases: {
        intake: { title: 'Intake', kind: 'resting', nextPhases: ['triage', 'done'] },
        triage: { title: 'Triage', kind: 'working', role: 'triage', nextPhases: ['done'] },
        done: { title: 'Done', kind: 'terminal' },
      },
      sourceClosed: { completed: 'done', canceled: 'done' },
    }),
  ],
});

interface StoredRoute {
  id: string;
  name: string;
  enabled: boolean;
  when: RuleGroup | null;
  on: string[];
  target: { boardKey: string; phaseKey: string | null };
  origin: unknown;
  createdBy: string;
  revision: number;
}

/** The routes and settings as far as the migration uses them; a route with a fixed id is written once. */
function fixture(lists: Record<string, unknown>, bindings: Array<{ sourceId: string; factoryProjectId: string; board: string | null }>) {
  let saved: unknown = { lists };
  const routes = new Map<string, StoredRoute[]>();
  const settings = {
    settings: {
      get: async () => saved,
      save: async (_org: string, _user: string, value: unknown) => {
        saved = value;
      },
    },
  };
  const intakeRoutes = {
    listIntakeRoutes: async (scope: { factoryProjectId: string }) => (routes.get(scope.factoryProjectId) ?? []) as never,
    createIntakeRoute: async (scope: { factoryProjectId: string }, input: any, actor: string, options: { id?: string } = {}) => {
      const all = routes.get(scope.factoryProjectId) ?? [];
      const existing = all.find(route => route.id === options.id);
      if (existing) return existing as never;
      const route: StoredRoute = {
        id: options.id ?? `random-${all.length}`,
        name: input.name,
        enabled: true,
        when: input.when,
        on: input.on,
        target: { boardKey: input.target.boardKey, phaseKey: input.target.phaseKey ?? null },
        origin: input.origin ?? null,
        createdBy: actor,
        revision: 1,
      };
      routes.set(scope.factoryProjectId, [...all, route]);
      return route as never;
    },
    updateIntakeRoute: async (scope: { factoryProjectId: string }, id: string, patch: any) => {
      const route = (routes.get(scope.factoryProjectId) ?? []).find(candidate => candidate.id === id)!;
      Object.assign(route, patch, { revision: route.revision + 1 });
      return route as never;
    },
  };
  const run = () =>
    migrateListStatusRules({
      orgIds: ['org'],
      settings: settings as never,
      intake: { listBindings: async () => bindings.map(binding => ({ integrationId: 'clickup', ...binding })) } as never,
      intakeRoutes,
      projectBoards: { load: async () => registry },
    });
  return { run, routes, settings };
}

describe('migrateListStatusRules', () => {
  it("turns each List's status rules into routes of its Factory, on its board, with their origin, and clears the rules", async () => {
    const { run, routes, settings } = fixture(
      {
        L1: {
          statuses: {
            'to do': { action: 'import' },
            'in progress': { action: 'phase', phase: 'triage' },
            'dev fixed': { action: 'close' },
          },
        },
        L2: { statuses: { bugs: { action: 'phase', phase: 'intake' } } },
      },
      [
        { sourceId: 'L1', factoryProjectId: 'syncts', board: 'work' },
        { sourceId: 'L2', factoryProjectId: 'post-airborne', board: 'work' },
      ],
    );
    expect(await run()).toEqual({ lists: 2, named: 0 });
    expect(routes.get('syncts')!.map(route => [route.name, route.on, route.target.phaseKey])).toEqual([
      ['ClickUp status “to do”', ['work_item.created'], null],
      ['ClickUp status “in progress”', ['work_item.created', 'work_item.state_changed'], 'triage'],
      ['ClickUp status “dev fixed”', ['work_item.state_changed'], 'done'],
    ]);
    const [first] = routes.get('syncts')!;
    expect(first).toMatchObject({
      id: statusRouteId('org', 'syncts', 'L1', 'to do'),
      when: listStatusCondition('L1', 'to do'),
      createdBy: STATUS_ROUTE_MIGRATION_ACTOR,
      origin: { kind: 'clickup-status', listId: 'L1', status: 'to do', generatedName: 'ClickUp status “to do”' },
    });
    expect(routes.get('post-airborne')).toHaveLength(1);
    expect((await readClickUpSettings(settings as never, 'org')).lists).toEqual({});
  });

  it('writes each route once, on a rerun or on two replicas at once (fixed ids)', async () => {
    const lists = { L1: { statuses: { 'to do': { action: 'import' } } } };
    const { run, routes } = fixture(lists, [{ sourceId: 'L1', factoryProjectId: 'syncts', board: 'work' }]);
    await Promise.all([run(), run()]);
    await run();
    expect(routes.get('syncts')).toHaveLength(1);
  });

  it('keeps the rules of a List not yet bound to a Factory and a board, for when it is', async () => {
    const lists = { L1: { statuses: { 'to do': { action: 'import' } } } };
    const { run, routes, settings } = fixture(lists, [{ sourceId: 'L1', factoryProjectId: 'syncts', board: null }]);
    expect(await run()).toEqual({ lists: 0, named: 0 });
    expect(routes.size).toBe(0);
    expect((await readClickUpSettings(settings as never, 'org')).lists).toEqual(lists);
  });

  it('gives the routes an earlier migration wrote their origin, so the settings can name them', async () => {
    const { run, routes } = fixture({}, [{ sourceId: 'L1', factoryProjectId: 'syncts', board: 'work' }]);
    routes.set('syncts', [
      {
        id: 'old',
        name: 'ClickUp: статус «to do»',
        enabled: true,
        when: listStatusCondition('L1', 'to do'),
        on: ['work_item.created'],
        target: { boardKey: 'work', phaseKey: 'triage' },
        origin: null,
        createdBy: STATUS_ROUTE_MIGRATION_ACTOR,
        revision: 1,
      },
    ]);
    expect(await run()).toEqual({ lists: 0, named: 1 });
    expect(routes.get('syncts')![0]!.origin).toEqual({
      kind: 'clickup-status',
      listId: 'L1',
      status: 'to do',
      generatedName: 'ClickUp: статус «to do»',
    });
    expect(await run()).toEqual({ lists: 0, named: 0 });
  });

  it('names the List in every moved route, which is what subscribes the project to it', async () => {
    const { run, routes } = fixture({ L1: { statuses: { 'to do': { action: 'import' } } } }, [
      { sourceId: 'L1', factoryProjectId: 'syncts', board: 'work' },
    ]);
    await run();
    const route = routes.get('syncts')![0]! as unknown as IntakeRoute;
    expect(statusRouteParts(route.when)).toEqual({ listId: 'L1', status: 'to do' });
    expect(routeSubscribesSource([route], { 'source.list': 'L1', 'item.state': 'to do' })).toBe(true);
    expect(routeSubscribesSource([route], { 'source.list': 'L2', 'item.state': 'to do' })).toBe(false);
  });
});
