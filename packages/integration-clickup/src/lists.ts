import { routedSourceLists } from '@factory/core';
import type { IntakeRoutesReader } from '@factory/core';
import type { FactoryProject, FactoryProjectsStorage, IntakeStorage } from '@factory/store';

export const CLICKUP_INTEGRATION_ID = 'clickup';

/** A ClickUp List a Factory reads, because one of its intake routes names it (`source.list`). */
export interface RoutedList {
  project: FactoryProject;
  listId: string;
}

/**
 * The Lists ClickUp reads, per Factory: the Lists its intake routes name (ADR-0021). A route is the
 * subscription, so there is no separate list of connected Lists; a List named by two Factories'
 * routes is read for each of them. Nothing is read for an organization whose ClickUp import is
 * switched off («Імпортувати задачі ClickUp»).
 */
export async function routedClickUpLists(options: {
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  intake: Pick<IntakeStorage, 'getConfig'>;
  intakeRoutes: IntakeRoutesReader;
}): Promise<RoutedList[]> {
  const projects = await options.projects.listAll();
  const enabled = new Map<string, boolean>();
  const lists: RoutedList[] = [];
  for (const project of projects) {
    if (!enabled.has(project.orgId)) {
      const selection = (await options.intake.getConfig({ orgId: project.orgId, integrationIds: [CLICKUP_INTEGRATION_ID] }))[
        CLICKUP_INTEGRATION_ID
      ];
      enabled.set(project.orgId, selection?.enabled === true);
    }
    if (!enabled.get(project.orgId)) continue;
    const routes = await options.intakeRoutes.listIntakeRoutes({ orgId: project.orgId, factoryProjectId: project.id });
    for (const listId of routedSourceLists(routes)) lists.push({ project, listId });
  }
  return lists;
}
