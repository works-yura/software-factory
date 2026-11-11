import { routedSourceScopes } from '@factory/core';
import type { IntakeRoute } from '@factory/core';
import { createFactoryStorageForTests } from '@factory/store/testing';
import { describe, expect, it } from 'vitest';

import { migrateGithubRepositorySelections, subscribeLinkedRepository } from './repository-subscriptions.ts';

async function seed() {
  const seeded = await createFactoryStorageForTests();
  const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'syncts' } });
  const other = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'post-airborne' } });
  const github = seeded.sourceControl.forIntegration('github');
  const installation = await github.installations.upsert({ orgId: 'org-1', connectedByUserId: 'user-1', externalId: '42' });
  const links: Record<string, { connectionId: string; repositoryId: string }> = {};
  const link = async (factoryProjectId: string, externalId: string, slug: string) => {
    const connection =
      (await github.connections.list({ orgId: 'org-1', factoryProjectId }))[0] ??
      (await github.connections.create({
        orgId: 'org-1',
        factoryProjectId,
        installationId: installation.id,
        createdByUserId: 'user-1',
      }));
    const repository = await github.repositories.upsert({
      orgId: 'org-1',
      input: { installationId: installation.id, externalId, slug, defaultBranch: 'main' },
    });
    const projectRepository = await github.projectRepositories.link({
      orgId: 'org-1',
      connectionId: connection.id,
      repositoryId: repository.id,
      createdByUserId: 'user-1',
      sandboxProvider: 'local',
      sandboxWorkdir: '/workspace',
    });
    links[slug] = projectRepository;
    return repository;
  };
  return { seeded, project, other, github, link, links };
}

const named = async (boards: { listIntakeRoutes: (scope: never) => Promise<unknown> }, orgId: string, factoryProjectId: string) =>
  routedSourceScopes(
    (await boards.listIntakeRoutes({ orgId, factoryProjectId } as never)) as IntakeRoute[],
    'source.repository',
    'github',
  );

describe('GitHub repositories are read through routes', () => {
  it('turns the old org-wide selection into one route per selected linked repository, once', async () => {
    const { seeded, project, other, github, link } = await seed();
    const front = await link(project.id, '1', 'Eclipt-AI/syncta_front');
    await link(project.id, '2', 'Eclipt-AI/syncta_back');
    await link(project.id, '3', 'Eclipt-AI/syncta_admin');
    await link(other.id, '4', 'Eclipt-AI/post-airborne');
    // The selection names repositories by id or by full name (any case); an unlinked one is ignored.
    await seeded.intake.saveConfig({
      orgId: 'org-1',
      config: {
        github: { enabled: true, sourceIds: [front.id, 'eclipt-ai/syncta_back', 'Eclipt-AI/post-airborne', 'acme/gone'] },
      },
    });
    const deps = { projects: seeded.projects, intake: seeded.intake, sourceControl: github, boards: seeded.storedBoards };

    expect(await migrateGithubRepositorySelections(deps)).toEqual({ routes: 3 });
    expect(await migrateGithubRepositorySelections(deps)).toEqual({ routes: 0 });

    expect(await named(seeded.storedBoards, 'org-1', project.id)).toEqual(['Eclipt-AI/syncta_front', 'Eclipt-AI/syncta_back']);
    expect(await named(seeded.storedBoards, 'org-1', other.id)).toEqual(['Eclipt-AI/post-airborne']);

    // Each lands where the catch-all would have, just ahead of it, so placement is unchanged.
    const routes = await seeded.storedBoards.listIntakeRoutes({ orgId: 'org-1', factoryProjectId: project.id });
    const catchAll = routes.at(-1)!;
    expect(catchAll.when).toBeNull();
    const added = routes.filter(route => route.origin?.kind === 'repository');
    expect(added.map(route => route.target)).toEqual([catchAll.target, catchAll.target]);
    expect(routes.indexOf(added[1]!)).toBe(routes.length - 2);
    expect(added[0]!.origin).toMatchObject({ kind: 'repository', integrationId: 'github', repository: 'Eclipt-AI/syncta_front' });
  });

  it('adds nothing for an org that selected no GitHub repository', async () => {
    const { seeded, project, github, link } = await seed();
    await link(project.id, '1', 'Eclipt-AI/syncta_front');
    const deps = { projects: seeded.projects, intake: seeded.intake, sourceControl: github, boards: seeded.storedBoards };

    expect(await migrateGithubRepositorySelections(deps)).toEqual({ routes: 0 });
    expect(await named(seeded.storedBoards, 'org-1', project.id)).toEqual([]);
  });

  it('subscribes a project to a repository when it is linked, once', async () => {
    const { seeded, project, github, link, links } = await seed();
    await link(project.id, '1', 'Eclipt-AI/syncta_front');
    const args = { orgId: 'org-1', projectRepository: links['Eclipt-AI/syncta_front']!, sourceControl: github, boards: seeded.storedBoards };

    expect(await subscribeLinkedRepository(args)).toBe(true);
    expect(await subscribeLinkedRepository(args)).toBe(false);
    expect(await named(seeded.storedBoards, 'org-1', project.id)).toEqual(['Eclipt-AI/syncta_front']);
  });
});
