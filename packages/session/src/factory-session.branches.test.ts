import { describe, expect, it } from 'vitest';

import { workItemBranch } from '@factory/pipelines';
import type { CreateSourceControlSessionInput, ProjectRepository, SourceControlStorageHandle } from '@factory/store';
import { createFactoryStorageForTests } from '@factory/testing';

import { ensureFactorySourceSession } from './factory-session.ts';

// The two cross-repository cases upstream c3a2784881 (#28152) added to
// storage/domains/source-control/base.test.ts. They start sessions through
// ensureFactorySourceSession, which @factory/store cannot import, so they live
// here with copies of that suite's fixtures.

const repositoryInput = {
  externalId: 'repository-34',
  slug: 'mastra-ai/mastra',
  defaultBranch: 'main',
  providerMetadata: { visibility: 'public' },
};

const projectRepositoryInput = {
  createdByUserId: 'user-1',
  branch: null,
  sandboxProvider: 'local',
  sandboxWorkdir: '/workspace/mastra',
};

const fixtureSession = (
  input: Omit<CreateSourceControlSessionInput, 'factoryProjectId'> & { factoryProjectId?: string },
) => input as CreateSourceControlSessionInput;

describe('session branches across the repositories of one factory', () => {
  async function setup() {
    const seeded = await createFactoryStorageForTests();
    const github = seeded.sourceControl.forIntegration('github');
    const createProject = () =>
      seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Factory project' } });
    const installation = await github.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: 'github-installation',
      accountName: 'mastra-ai',
      accountType: 'organization',
    });
    async function linkRepository(args: {
      factoryProjectId: string;
      repositoryExternalId?: string;
      repositorySlug?: string;
    }): Promise<ProjectRepository> {
      const repository = await github.repositories.upsert({
        orgId: 'org-1',
        input: {
          installationId: installation.id,
          ...repositoryInput,
          externalId: args.repositoryExternalId ?? repositoryInput.externalId,
          slug: args.repositorySlug ?? repositoryInput.slug,
        },
      });
      const connection = await github.connections.create({
        orgId: 'org-1',
        factoryProjectId: args.factoryProjectId,
        installationId: installation.id,
        createdByUserId: 'user-1',
      });
      return github.projectRepositories.link({
        orgId: 'org-1',
        connectionId: connection.id,
        repositoryId: repository.id,
        ...projectRepositoryInput,
      });
    }
    async function twoLinks(factoryProjectId: string) {
      const first = await linkRepository({ factoryProjectId });
      const second = await linkRepository({
        factoryProjectId,
        repositoryExternalId: 'repo-2',
        repositorySlug: 'mastra-ai/second',
      });
      return { first, second };
    }
    return { github: github as SourceControlStorageHandle, createProject, twoLinks };
  }

  const sessionInput = (sessionId: string, projectRepositoryId: string, userId = 'user-1', branch = 'feat/x') =>
    fixtureSession({
      sessionId,
      projectRepositoryId,
      orgId: 'org-1',
      userId,
      branch,
      baseBranch: 'main',
    });

  it.each(['github-issue', 'github-pr'] as const)(
    'starts %s cards numbered 13 in two repositories and reuses retries (#28048)',
    async source => {
      const { github, createProject, twoLinks } = await setup();
      const project = await createProject();
      const { first, second } = await twoLinks(project.id);
      const start = (projectRepositoryId: string, id: string) =>
        ensureFactorySourceSession({
          sourceControl: github,
          orgId: 'org-1',
          factoryProjectId: project.id,
          projectRepositoryId,
          branch: workItemBranch({ id, source, metadata: { number: 13 } }),
        });
      const a = await start(first.id, 'aaaaaaaa-0000-4000-8000-000000000001');
      const b = await start(second.id, 'bbbbbbbb-0000-4000-8000-000000000002');
      expect(a.branch).not.toBe(b.branch);
      expect(a.userId).toBe(b.userId);
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(await start(first.id, 'aaaaaaaa-0000-4000-8000-000000000001')).toEqual(a);
      expect(await github.sessions.listByProjectRepository({ projectRepositoryId: first.id })).toHaveLength(1);
      expect(await github.sessions.listByProjectRepository({ projectRepositoryId: second.id })).toHaveLength(1);
    },
  );

  it.each(['github-issue', 'github-pr'] as const)(
    'reuses an existing legacy %s branch only on its repository link',
    async source => {
      const { github, createProject, twoLinks } = await setup();
      const project = await createProject();
      const { first, second } = await twoLinks(project.id);
      const branch = source === 'github-pr' ? 'factory/pr-13' : 'factory/issue-13';
      const existing = await github.sessions.create(sessionInput('legacy-card', first.id, 'user-1', branch));
      const start = (projectRepositoryId: string, id: string) =>
        ensureFactorySourceSession({
          sourceControl: github,
          orgId: 'org-1',
          factoryProjectId: project.id,
          projectRepositoryId,
          branch: workItemBranch({ id, source, metadata: { number: 13 } }),
        });
      const resumed = await start(first.id, 'aaaaaaaa-0000-4000-8000-000000000001');
      expect(resumed).toMatchObject({ sessionId: existing.sessionId, branch });
      const fresh = await start(second.id, 'bbbbbbbb-0000-4000-8000-000000000002');
      expect(fresh.sessionId).not.toBe(existing.sessionId);
      expect(fresh.branch).not.toBe(branch);
      expect(await github.sessions.listByProjectRepository({ projectRepositoryId: first.id })).toHaveLength(1);
    },
  );
});
