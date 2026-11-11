import { createFactoryStorageForTests } from '@factory/store/testing';
import { describe, expect, it } from 'vitest';

import { canonicalizeProjectRoutes, migrateCanonicalRoutes } from './canonical-routes.ts';

const sourceOf = (route: { when: { conditions: unknown[] } | null }) =>
  (route.when?.conditions ?? []).filter(
    (condition): condition is { field: string; operator: string; value?: unknown } =>
      typeof condition === 'object' && condition !== null && (condition as { field?: string }).field === 'source.integration',
  );

async function seed() {
  const seeded = await createFactoryStorageForTests();
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'syncts' } });
  const scope = { orgId: 'org-1', factoryProjectId: project.id };
  return { seeded, project, scope };
}

describe('stored routes in the one-source form', () => {
  it("names GitHub on the default routes of a project that links only GitHub repositories, and leaves the rest", async () => {
    const { seeded, scope } = await seed();
    const github = seeded.sourceControl.forIntegration('github');
    const installation = await github.installations.upsert({ orgId: 'org-1', connectedByUserId: 'user-1', externalId: '1' });
    await github.connections.create({ ...scope, installationId: installation.id, createdByUserId: 'user-1' });
    const before = await seeded.storedBoards.listIntakeRoutes(scope);

    expect(
      await migrateCanonicalRoutes({ projects: seeded.projects, sourceControl: seeded.sourceControl, boards: seeded.storedBoards }),
    ).toEqual({ rewritten: 4, added: 0 });
    expect(
      await migrateCanonicalRoutes({ projects: seeded.projects, sourceControl: seeded.sourceControl, boards: seeded.storedBoards }),
    ).toEqual({ rewritten: 0, added: 0 });

    const after = await seeded.storedBoards.listIntakeRoutes(scope);
    expect(after.map(route => route.id)).toEqual(before.map(route => route.id));
    const byName = new Map(after.map(route => [route.name, route]));
    // A set of hosts, or a host-only fact with no source named: the host the project links from.
    for (const name of [
      'Outside authors wait in Intake',
      'Pull requests go to Review',
      'Pull requests closed unmerged go to Canceled',
      'Pull requests that close a waiting issue join its card',
    ]) {
      expect(sourceOf(byName.get(name)!)).toEqual([{ field: 'source.integration', operator: 'equals', value: 'github' }]);
    }
    // A pull request event concerns a card from any source (a ClickUp card whose session opened it): no source named.
    for (const name of [
      'Merged pull requests go to Done',
      'Pushes to a reviewed pull request re-review it',
      'Requested reviews go to Review',
      // `source.kind ≠ pull_request` matches ClickUp cards too.
      'Issues whose pull request closed unmerged go back to Intake',
      'Everything else goes to Work › Intake',
    ]) {
      expect(sourceOf(byName.get(name)!)).toEqual([]);
    }
    // The other conditions stay, after the source.
    expect(byName.get('Outside authors wait in Intake')!.when!.conditions).toEqual([
      { field: 'source.integration', operator: 'equals', value: 'github' },
      { field: 'author.trusted', operator: 'equals', value: false },
    ]);
  });

  it('splits a route for both hosts into one per host, the second right after the first', async () => {
    const { seeded, scope } = await seed();
    const before = await seeded.storedBoards.listIntakeRoutes(scope);
    const outsiders = before.find(route => route.name === 'Outside authors wait in Intake')!;

    const result = await canonicalizeProjectRoutes({
      boards: seeded.storedBoards,
      scope,
      linkedHosts: new Set(['github', 'gitlab']),
    });

    expect(result.added).toBe(4);
    const after = await seeded.storedBoards.listIntakeRoutes(scope);
    const at = after.findIndex(route => route.id === outsiders.id);
    expect(sourceOf(after[at]!)).toEqual([{ field: 'source.integration', operator: 'equals', value: 'github' }]);
    expect(after[at + 1]!.name).toBe(outsiders.name);
    expect(sourceOf(after[at + 1]!)).toEqual([{ field: 'source.integration', operator: 'equals', value: 'gitlab' }]);
    // The catch-all is still last.
    expect(after.at(-1)!.name).toBe('Everything else goes to Work › Intake');
  });

  it('names ClickUp on a status route written before routes named their source', async () => {
    const { seeded, scope } = await seed();
    const route = await seeded.storedBoards.createIntakeRoute(
      scope,
      {
        name: 'ClickUp status “to do”',
        on: ['work_item.created', 'work_item.state_changed'],
        when: {
          operator: 'AND',
          conditions: [
            { field: 'source.list', operator: 'equals', value: 'list-1' },
            { field: 'item.state', operator: 'equals', value: 'to do' },
          ],
        },
        target: { boardKey: 'work', phaseKey: 'triage' },
      },
      'test',
    );

    await canonicalizeProjectRoutes({ boards: seeded.storedBoards, scope, linkedHosts: new Set(['github']) });

    const after = (await seeded.storedBoards.listIntakeRoutes(scope)).find(candidate => candidate.id === route.id)!;
    expect(after.when!.conditions).toEqual([
      { field: 'source.integration', operator: 'equals', value: 'clickup' },
      { field: 'source.list', operator: 'equals', value: 'list-1' },
      { field: 'item.state', operator: 'equals', value: 'to do' },
    ]);
    expect(after.on).toEqual(['work_item.created', 'work_item.state_changed']);
  });

  it('names GitHub, the first host, when the project links no repository', async () => {
    const { seeded, scope } = await seed();

    await canonicalizeProjectRoutes({ boards: seeded.storedBoards, scope, linkedHosts: new Set() });

    const outsiders = (await seeded.storedBoards.listIntakeRoutes(scope)).find(
      route => route.name === 'Outside authors wait in Intake',
    )!;
    expect(sourceOf(outsiders)).toEqual([{ field: 'source.integration', operator: 'equals', value: 'github' }]);
  });
});
