import type { BoardRegistry, IntakeRoutesReader, RuleGroup, StatusEvent } from '@factory/core';
import type { IntakeStorage, IntegrationStorageHandle, StoredBoardsStorage } from '@factory/store';

import { readClickUpSettings, saveListRules } from './settings.ts';
import type { StatusRule } from './settings.ts';

/** Who the routes made from a List's status rules are attributed to in their history. */
export const STATUS_ROUTE_MIGRATION_ACTOR = 'system:clickup-status-route-migration';

/** Whether a route's condition names a ClickUp List: such a route imports that List's tasks. */
export function routeNamesList(when: RuleGroup | null): boolean {
  if (!when) return false;
  return when.conditions.some(member =>
    'conditions' in member ? routeNamesList(member) : member.field === 'source.list',
  );
}

/** The condition a status rule stood for: a task of this List with this status. */
export function listStatusCondition(listId: string, status: string): RuleGroup {
  return {
    operator: 'AND',
    conditions: [
      { field: 'source.list', operator: 'equals', value: listId },
      { field: 'item.state', operator: 'equals', value: status },
    ],
  };
}

export interface StatusRoute {
  name: string;
  when: RuleGroup;
  on: StatusEvent[];
  target: { boardKey: string; phaseKey: string | null };
}

/**
 * The intake route that does what a List's status rule did, on the List's board:
 * - `import` — a new task with this status is filed in the board's first phase (other routes with a
 *   condition still win, as they did); later status changes leave the card alone;
 * - `phase` — a new task is filed in that phase, and a later change to this status moves the card
 *   there while it still sits where its previous status put it;
 * - `close` — a change to this status finishes the card the way the board does when its source
 *   closes; a new task with this status is not imported.
 * `ignore` needs no route (a status no route names is not imported). Undefined when the rule can't
 * be carried out on this board (a close on a board without a close phase did nothing before either).
 */
export function statusRoute(
  listId: string,
  status: string,
  rule: StatusRule,
  board: { id: string; sourceClosed?: { completed: string } },
): StatusRoute | undefined {
  const when = listStatusCondition(listId, status);
  const name = `ClickUp: статус «${status}»`;
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

const sameRoute = (
  route: { when: RuleGroup | null; on: readonly string[]; target: { boardKey: string; phaseKey?: string | null } },
  wanted: StatusRoute,
) =>
  JSON.stringify(route.when) === JSON.stringify(wanted.when) &&
  [...route.on].sort().join() === [...wanted.on].sort().join() &&
  route.target.boardKey === wanted.target.boardKey &&
  (route.target.phaseKey ?? null) === wanted.target.phaseKey;

/**
 * Moves an organization's per-List status rules (Settings › Intake › ClickUp, retired) into the
 * intake routes of the Factory each List belongs to, then clears the List's rules. A List not yet
 * routed to a Factory and a board keeps its rules until it is: they never applied before that
 * either. A route an earlier, interrupted run already added is not added twice. Returns how many
 * Lists were moved.
 */
export async function migrateListStatusRules({
  orgId,
  settings,
  intake,
  boards,
  projectBoards,
}: {
  orgId: string;
  settings: Pick<IntegrationStorageHandle, 'settings'>;
  intake: Pick<IntakeStorage, 'listBindings'>;
  boards: IntakeRoutesReader & Pick<StoredBoardsStorage, 'createIntakeRoute'>;
  projectBoards: { load(scope: { orgId: string; factoryProjectId: string }): Promise<Pick<BoardRegistry, 'get'>> };
}): Promise<number> {
  const { lists } = await readClickUpSettings(settings, orgId);
  const listIds = Object.keys(lists);
  if (listIds.length === 0) return 0;
  const bindings = await intake.listBindings({ orgId, integrationId: 'clickup' });
  let moved = 0;
  for (const listId of listIds) {
    const binding = bindings.find(candidate => candidate.sourceId === listId);
    if (!binding?.board) continue;
    const scope = { orgId, factoryProjectId: binding.factoryProjectId };
    const registry = await projectBoards.load(scope);
    const board = registry.get(binding.board);
    if (!board) continue;
    const existing = await boards.listIntakeRoutes(scope);
    for (const [status, rule] of Object.entries(lists[listId]!.statuses)) {
      const route = statusRoute(listId, status, rule, board);
      if (!route || existing.some(candidate => sameRoute(candidate, route))) continue;
      await boards.createIntakeRoute(
        scope,
        { name: route.name, when: route.when, on: route.on, target: route.target },
        STATUS_ROUTE_MIGRATION_ACTOR,
      );
    }
    await saveListRules(settings, orgId, listId, { statuses: {} });
    moved += 1;
  }
  return moved;
}
