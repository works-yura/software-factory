import { createHash } from 'node:crypto';

import type { BoardRegistry, RuleGroup, StatusEvent } from '@factory/core';
import type { IntakeStorage, IntegrationStorageHandle, StoredBoardsStorage } from '@factory/store';

import { readClickUpSettings, saveListRules } from './settings.ts';
import type { StatusRule } from './settings.ts';

/** The actor on the routes Factory writes from a List's retired status rules. */
export const STATUS_ROUTE_MIGRATION_ACTOR = 'system:clickup-status-route-migration';

/** The condition of a status route: ClickUp tasks of this List with this status. */
export function listStatusCondition(listId: string, status: string): RuleGroup {
  return {
    operator: 'AND',
    conditions: [
      { field: 'source.integration', operator: 'equals', value: 'clickup' },
      { field: 'source.list', operator: 'equals', value: listId },
      { field: 'item.state', operator: 'equals', value: status },
    ],
  };
}

/**
 * The List and status a route's condition names, when it is exactly a status route's condition
 * (with or without the `source.integration = clickup` condition routes written earlier lack).
 */
export function statusRouteParts(when: RuleGroup | null): { listId: string; status: string } | undefined {
  if (!when || when.operator !== 'AND') return undefined;
  const [first, ...others] = when.conditions;
  const namesClickUp =
    first && 'field' in first && first.field === 'source.integration' && first.operator === 'equals' && first.value === 'clickup';
  const parts = namesClickUp ? others : when.conditions;
  if (parts.length !== 2) return undefined;
  const [list, state] = parts;
  if (!list || !state || 'conditions' in list || 'conditions' in state) return undefined;
  if (list.field !== 'source.list' || state.field !== 'item.state') return undefined;
  if (list.operator !== 'equals' || state.operator !== 'equals') return undefined;
  if (typeof list.value !== 'string' || typeof state.value !== 'string') return undefined;
  return { listId: list.value, status: state.value };
}

/** The name Factory gives a status route; the settings show it in the reader's language (`origin`). */
export function statusRouteName(status: string): string {
  return `ClickUp status “${status}”`;
}

export interface StatusRoute {
  name: string;
  when: RuleGroup;
  on: StatusEvent[];
  target: { boardKey: string; phaseKey: string | null };
}

/**
 * The intake route a retired List status rule becomes, on the List's board:
 * - `import` places a new task with that status in the board's first phase;
 * - `phase` places a new task there and moves the card there when the task's status changes to it;
 * - `close` moves the card to the board's completed phase when the status changes to it (only a
 *   board that closes cards has one; on any other, the rule did nothing and no route is made);
 * - `ignore` makes no route.
 */
export function statusRoute(
  listId: string,
  status: string,
  rule: StatusRule,
  board: { id: string; sourceClosed?: { completed: string } },
): StatusRoute | undefined {
  const when = listStatusCondition(listId, status);
  const name = statusRouteName(status);
  switch (rule.action) {
    case 'ignore':
      return undefined;
    case 'import':
      return { name, when, on: ['work_item.created'], target: { boardKey: board.id, phaseKey: null } };
    case 'phase':
      return {
        name,
        when,
        on: ['work_item.created', 'work_item.state_changed'],
        target: { boardKey: board.id, phaseKey: rule.phase },
      };
    case 'close':
      return board.sourceClosed
        ? { name, when, on: ['work_item.state_changed'], target: { boardKey: board.id, phaseKey: board.sourceClosed.completed } }
        : undefined;
  }
}

/**
 * The fixed id of the route a List status migrates into: the same on every replica and every run,
 * so the route is written once (the id is the routes table's primary key).
 */
export function statusRouteId(orgId: string, factoryProjectId: string, listId: string, status: string): string {
  const hex = createHash('sha256').update(`clickup-status-route\u0000${orgId}\u0000${factoryProjectId}\u0000${listId}\u0000${status}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface StatusRouteMigration {
  /** Lists whose rules became routes on this run. */
  lists: number;
  /** Routes Factory wrote before that now carry their origin, so the settings can name them. */
  named: number;
}

/**
 * Moves each List's retired status rules (the per-List settings) into intake routes on the List's
 * Factory and board, then clears them — run once per boot by the integration's `migrate`. Each
 * route gets a fixed id ({@link statusRouteId}), so a rerun or a second replica adds nothing twice.
 * A List not bound to a Factory and a board keeps its rules (they did nothing before either).
 * Routes an earlier migration wrote without an origin get one, so the settings show their name
 * in the reader's language.
 */
export async function migrateListStatusRules({
  orgIds,
  settings,
  intake,
  intakeRoutes,
  projectBoards,
}: {
  orgIds: readonly string[];
  settings: Pick<IntegrationStorageHandle, 'settings'>;
  intake: Pick<IntakeStorage, 'listBindings'>;
  intakeRoutes: Pick<StoredBoardsStorage, 'listIntakeRoutes' | 'createIntakeRoute' | 'updateIntakeRoute'>;
  projectBoards: { load(scope: { orgId: string; factoryProjectId: string }): Promise<Pick<BoardRegistry, 'get'>> };
}): Promise<StatusRouteMigration> {
  const result: StatusRouteMigration = { lists: 0, named: 0 };
  const scopes = new Map<string, { orgId: string; factoryProjectId: string }>();
  for (const orgId of orgIds) {
    const bindings = await intake.listBindings({ orgId, integrationId: 'clickup' });
    for (const binding of bindings) scopes.set(`${orgId}:${binding.factoryProjectId}`, { orgId, factoryProjectId: binding.factoryProjectId });
    const { lists } = await readClickUpSettings(settings, orgId);
    for (const [listId, rules] of Object.entries(lists)) {
      const binding = bindings.find(candidate => candidate.sourceId === listId);
      if (!binding?.board) continue;
      const scope = { orgId, factoryProjectId: binding.factoryProjectId };
      const board = (await projectBoards.load(scope)).get(binding.board);
      if (!board) continue;
      for (const [status, rule] of Object.entries(rules.statuses)) {
        const route = statusRoute(listId, status, rule, board);
        if (!route) continue;
        await intakeRoutes.createIntakeRoute(
          scope,
          {
            ...route,
            origin: { kind: 'clickup-status', listId, status, generatedName: route.name },
          },
          STATUS_ROUTE_MIGRATION_ACTOR,
          { id: statusRouteId(orgId, binding.factoryProjectId, listId, status) },
        );
      }
      await saveListRules(settings, orgId, listId, { statuses: {} });
      result.lists += 1;
    }
  }
  for (const scope of scopes.values()) {
    for (const route of await intakeRoutes.listIntakeRoutes(scope)) {
      if (route.origin || route.createdBy !== STATUS_ROUTE_MIGRATION_ACTOR) continue;
      const parts = statusRouteParts(route.when);
      if (!parts) continue;
      await intakeRoutes.updateIntakeRoute(
        scope,
        route.id,
        { origin: { kind: 'clickup-status', ...parts, generatedName: route.name } },
        { expectedRevision: route.revision, actor: STATUS_ROUTE_MIGRATION_ACTOR },
      );
      result.named += 1;
    }
  }
  return result;
}
