import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '../testing.ts';
import { CATCH_ALL_INTAKE_ROUTE } from '../boards/base.ts';
import { labelRouteCondition, migrateLabelRoutesToIntakeRoutes } from './label-route-migration.ts';

const routeName = (label: string) => `ClickUp tag "${label}"`;

async function seed() {
  const storage = await createFactoryStorageForTests();
  const project = await storage.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Acme' } });
  const other = await storage.projects.create({ orgId: 'org-2', userId: 'user-2', input: { name: 'Other' } });
  const scope = { orgId: 'org-1', factoryProjectId: project.id };
  return { ...storage, project, other, scope };
}

describe('migrateLabelRoutesToIntakeRoutes', () => {
  it("moves each ClickUp tag route ahead of the project's catch-all, in every org, and leaves other integrations' label routes", async () => {
    const { intake, storedBoards, project, other, scope } = await seed();
    await intake.setLabelRoute({ ...scope, integrationId: 'clickup', label: 'Bug', board: 'work' });
    await intake.setLabelRoute({
      orgId: 'org-2',
      factoryProjectId: other.id,
      integrationId: 'clickup',
      label: 'docs',
      board: 'review',
    });
    await intake.setLabelRoute({ ...scope, integrationId: 'github', label: 'bug', board: 'work' });
    const before = await storedBoards.listIntakeRoutes(scope);

    const moved = await migrateLabelRoutesToIntakeRoutes({
      integrationId: 'clickup',
      routeName,
      intake,
      boards: storedBoards,
    });

    expect(moved).toBe(2);
    const after = await storedBoards.listIntakeRoutes(scope);
    const added = after.filter(route => !before.some(existing => existing.id === route.id));
    // The project's routes keep their order; the moved one goes just ahead of the catch-all, where
    // it can still place new cards.
    expect(after.filter(route => !added.includes(route)).map(route => route.id)).toEqual(before.map(route => route.id));
    expect(added).toMatchObject([
      {
        name: 'ClickUp tag "bug"',
        enabled: true,
        when: labelRouteCondition('clickup', 'bug'),
        target: { boardKey: 'work', phaseKey: null },
      },
    ]);
    expect(after[after.indexOf(added[0]!) + 1]).toMatchObject({ name: CATCH_ALL_INTAKE_ROUTE.name });
    expect(
      (await storedBoards.listIntakeRoutes({ orgId: 'org-2', factoryProjectId: other.id })).find(
        route => route.name === routeName('docs'),
      ),
    ).toMatchObject({ when: labelRouteCondition('clickup', 'docs'), target: { boardKey: 'review' } });
    expect(await intake.listLabelRoutes({ orgId: 'org-1', integrationId: 'clickup' })).toEqual([]);
    expect(await intake.listLabelRoutes({ orgId: 'org-2', integrationId: 'clickup' })).toEqual([]);
    expect(await intake.listLabelRoutes({ orgId: 'org-1', integrationId: 'github' })).toMatchObject([
      { factoryProjectId: project.id, label: 'bug' },
    ]);
  });

  it('adds no second route when an interrupted run already moved one, and does nothing once all are moved', async () => {
    const { intake, storedBoards, scope } = await seed();
    await storedBoards.createIntakeRoute(
      scope,
      { name: routeName('bug'), when: labelRouteCondition('clickup', 'bug'), target: { boardKey: 'work' } },
      'user-1',
    );
    await intake.setLabelRoute({ ...scope, integrationId: 'clickup', label: 'bug', board: 'work' });
    const before = await storedBoards.listIntakeRoutes(scope);

    const options = { integrationId: 'clickup', routeName, intake, boards: storedBoards };
    expect(await migrateLabelRoutesToIntakeRoutes(options)).toBe(1);
    expect(await migrateLabelRoutesToIntakeRoutes(options)).toBe(0);

    expect(await storedBoards.listIntakeRoutes(scope)).toHaveLength(before.length);
    expect(await intake.listLabelRoutes({ orgId: 'org-1', integrationId: 'clickup' })).toEqual([]);
  });
});
