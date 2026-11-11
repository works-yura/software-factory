import { describe, expect, it } from 'vitest';

import { createBoardRegistry, defineBoard } from '@factory/core';
import type { RuleGroup } from '@factory/core';

import { readClickUpSettings } from './settings.ts';
import { listStatusCondition, migrateListStatusRules, routeNamesList, STATUS_ROUTE_MIGRATION_ACTOR } from './status-routes.ts';

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
  name: string;
  when: RuleGroup | null;
  on: string[];
  target: { boardKey: string; phaseKey: string | null };
}

function fixture(lists: Record<string, unknown>, bindings: Array<{ sourceId: string; factoryProjectId: string; board: string | null }>) {
  let saved: unknown = { lists };
  const routes = new Map<string, StoredRoute[]>();
  const created: Array<{ scope: string; actor: string; route: StoredRoute }> = [];
  const settings = {
    settings: {
      get: async () => saved,
      save: async (_org: string, _user: string, value: unknown) => {
        saved = value;
      },
    },
  };
  const boards = {
    listIntakeRoutes: async (scope: { factoryProjectId: string }) => (routes.get(scope.factoryProjectId) ?? []) as never,
    createIntakeRoute: async (scope: { factoryProjectId: string }, input: any, actor: string) => {
      const route = { name: input.name, when: input.when, on: input.on, target: input.target };
      routes.set(scope.factoryProjectId, [...(routes.get(scope.factoryProjectId) ?? []), route]);
      created.push({ scope: scope.factoryProjectId, actor, route });
      return route as never;
    },
  };
  const run = () =>
    migrateListStatusRules({
      orgId: 'org',
      settings: settings as never,
      intake: { listBindings: async () => bindings.map(binding => ({ integrationId: 'clickup', ...binding })) } as never,
      boards,
      projectBoards: { load: async () => registry },
    });
  return { run, routes, created, settings };
}

describe('migrateListStatusRules', () => {
  it("turns each List's status rules into routes of its Factory, on its board, and clears the rules", async () => {
    const { run, routes, created, settings } = fixture(
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

    expect(await run()).toBe(2);

    expect(routes.get('syncts')).toEqual([
      {
        name: 'ClickUp: статус «to do»',
        when: listStatusCondition('L1', 'to do'),
        on: ['work_item.created'],
        target: { boardKey: 'work', phaseKey: null },
      },
      {
        name: 'ClickUp: статус «in progress»',
        when: listStatusCondition('L1', 'in progress'),
        on: ['work_item.created', 'work_item.state_changed'],
        target: { boardKey: 'work', phaseKey: 'triage' },
      },
      {
        name: 'ClickUp: статус «dev fixed»',
        when: listStatusCondition('L1', 'dev fixed'),
        on: ['work_item.state_changed'],
        target: { boardKey: 'work', phaseKey: 'done' },
      },
    ]);
    expect(routes.get('post-airborne')).toHaveLength(1);
    expect(created.every(entry => entry.actor === STATUS_ROUTE_MIGRATION_ACTOR)).toBe(true);
    expect((await readClickUpSettings(settings, 'org')).lists).toEqual({});
  });

  it('runs once: a second pass adds nothing, and a route an interrupted pass added is not added twice', async () => {
    const lists = { L1: { statuses: { 'to do': { action: 'import' } } } };
    const bindings = [{ sourceId: 'L1', factoryProjectId: 'syncts', board: 'work' }];
    const { run, routes, settings } = fixture(lists, bindings);
    await run();
    expect(await run()).toBe(0);
    expect(routes.get('syncts')).toHaveLength(1);

    // Interrupted after adding the route, before clearing the rules.
    await settings.settings.save('org', '__org__', { lists });
    await run();
    expect(routes.get('syncts')).toHaveLength(1);
  });

  it('keeps the rules of a List not yet routed to a Factory and a board, for when it is', async () => {
    const lists = { L1: { statuses: { 'to do': { action: 'import' } } }, L2: { statuses: { open: { action: 'import' } } } };
    const { run, routes, settings } = fixture(lists, [{ sourceId: 'L2', factoryProjectId: 'syncts', board: null }]);
    expect(await run()).toBe(0);
    expect(routes.size).toBe(0);
    expect((await readClickUpSettings(settings, 'org')).lists).toEqual(lists);
  });

  it('names the List in every moved route, which is what lets a route import a task', () => {
    expect(routeNamesList(listStatusCondition('L1', 'to do'))).toBe(true);
    expect(routeNamesList({ operator: 'AND', conditions: [{ field: 'item.labels', operator: 'contains', value: 'bug' }] })).toBe(
      false,
    );
    expect(routeNamesList(null)).toBe(false);
  });
});
