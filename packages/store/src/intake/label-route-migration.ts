import type { RuleGroup } from '@factory/core';

import type { StoredBoardsStorage } from '../boards/base.ts';
import type { IntakeStorage } from './base.ts';

/** Who the moved routes are attributed to in their history. */
export const LABEL_ROUTE_MIGRATION_ACTOR = 'system:label-route-migration';

/** The intake route condition a label route meant: an item from this integration carrying the label. */
export function labelRouteCondition(integrationId: string, label: string): RuleGroup {
  return {
    operator: 'AND',
    conditions: [
      { field: 'source.integration', operator: 'in', value: [integrationId] },
      { field: 'item.labels', operator: 'contains', value: label },
    ],
  };
}

/**
 * Moves one integration's label routes (ClickUp's tag routes) into their projects' intake routes,
 * each appended after the routes the project already has and landing in its board's first phase,
 * then removes the label route. A route already moved by an earlier, interrupted run is not added
 * twice. Returns how many label routes were moved.
 */
export async function migrateLabelRoutesToIntakeRoutes({
  integrationId,
  routeName,
  intake,
  boards,
}: {
  integrationId: string;
  /** The moved route's name, from its label: `ClickUp tag "bug"`. */
  routeName: (label: string) => string;
  intake: Pick<IntakeStorage, 'listLabelRoutesForIntegration' | 'clearLabelRoute'>;
  boards: Pick<StoredBoardsStorage, 'listIntakeRoutes' | 'createIntakeRoute'>;
}): Promise<number> {
  const labelRoutes = await intake.listLabelRoutesForIntegration(integrationId);
  for (const labelRoute of labelRoutes) {
    const scope = { orgId: labelRoute.orgId, factoryProjectId: labelRoute.factoryProjectId };
    const when = labelRouteCondition(integrationId, labelRoute.label);
    const existing = await boards.listIntakeRoutes(scope);
    const moved = existing.some(
      route => route.target.boardKey === labelRoute.board && JSON.stringify(route.when) === JSON.stringify(when),
    );
    if (!moved) {
      await boards.createIntakeRoute(
        scope,
        { name: routeName(labelRoute.label), when, target: { boardKey: labelRoute.board, phaseKey: null } },
        LABEL_ROUTE_MIGRATION_ACTOR,
      );
    }
    await intake.clearLabelRoute({ ...scope, integrationId, label: labelRoute.label });
  }
  return labelRoutes.length;
}
