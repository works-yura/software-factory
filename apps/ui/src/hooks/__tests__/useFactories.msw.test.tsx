/**
 * BDD coverage for the repository link mutation. Every place that links a
 * repository to a Factory (onboarding, the wizard, Settings › Repositories)
 * routes through it, so this is where "a linked repository feeds the board"
 * is guaranteed.
 *
 * Drives the real services + React Query cache; only the network is mocked
 * (MSW) on the ApiConfig base URL the test providers inject.
 */
import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished } from 'vitest';

import { listedRepository } from '../../../e2e/ui/factory-projects';
import { server } from '../../../e2e/ui/msw-server';
import { renderHookWithProviders, TEST_BASE_URL, waitForMutationsIdle } from '../../../e2e/ui/render';
import type { IntakeConfig } from '../../ui/domains/factory/services/intake';
import type { GitLabRepository } from '../../ui/domains/factory/services/gitlab';
import type { GithubRepo } from '../../ui/domains/workspaces/services/github';
import { useFactoriesQuery, useLinkRepositoryMutation } from '../useFactories';
import { useIntakeConfigQuery } from '../useIntakeConfig';

const CONFIG_URL = `${TEST_BASE_URL}/web/intake/config`;

const repo: GithubRepo = {
  id: 99,
  fullName: 'octo/hello',
  name: 'hello',
  owner: 'octo',
  defaultBranch: 'main',
  private: false,
  installationId: 7,
  installationStorageId: 'inst-7',
  sandboxProvider: 'local',
  sandboxWorkdir: '/workspace/hello',
};

const gitlabRepo: GitLabRepository = {
  provider: 'gitlab',
  id: 'gitlab-project:encoded',
  externalId: '10',
  fullName: 'acme/app',
  name: 'app',
  owner: 'acme',
  defaultBranch: 'main',
  private: true,
  sandboxProvider: 'local',
  sandboxWorkdir: '/workspace/app',
};

function stubRepositoryLink() {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections`, () =>
      HttpResponse.json({ connections: [{ id: 'conn-1', installationId: 'inst-7', repositories: [] }] }),
    ),
    http.post(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-1/repositories`, () =>
      HttpResponse.json({
        projectRepository: {
          id: 'ghp_1',
          branch: 'main',
          sandboxWorkdir: '/workspace/hello',
          repository: { slug: 'octo/hello', defaultBranch: 'main' },
        },
      }),
    ),
  );
}

/** Stateful intake config: each PUT becomes what the next GET returns. */
function stubIntakeConfig(initial: Partial<IntakeConfig>) {
  let config: Partial<IntakeConfig> = initial;
  const saved: IntakeConfig[] = [];
  server.use(
    http.get(CONFIG_URL, () => HttpResponse.json({ config })),
    http.put<never, IntakeConfig>(CONFIG_URL, async ({ request }) => {
      const next = await request.json();
      config = next;
      saved.push(next);
      return HttpResponse.json({ config });
    }),
  );
  return saved;
}

describe('useLinkRepositoryMutation', () => {
  it('links a GitLab project through its provider partition and feeds GitLab intake', async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${TEST_BASE_URL}/web/gitlab/projects/registration`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          project: {
            id: 'gitlab-project:encoded',
            name: 'acme/app',
            projectId: '10',
            projectPath: 'acme/app',
            installationStorageId: 'gitlab-inst-1',
            defaultBranch: 'main',
            sandboxProvider: 'local',
            sandboxWorkdir: '/workspace/app',
          },
        });
      }),
      http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections`, () =>
        HttpResponse.json({ connections: [] }),
      ),
      http.post(`${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({ connection: { id: 'conn-gl-1' } }, { status: 201 });
      }),
      http.post(
        `${TEST_BASE_URL}/web/factory/projects/fp-1/source-control-connections/conn-gl-1/repositories`,
        async ({ request }) => {
          requests.push(await request.json());
          return HttpResponse.json({
            projectRepository: {
              id: 'glp-1',
              branch: 'main',
              sandboxWorkdir: '/workspace/app',
              repository: { slug: 'acme/app', defaultBranch: 'main' },
            },
          });
        },
      ),
    );
    const saved = stubIntakeConfig({ gitlab: { enabled: false, sourceIds: null } });
    const { client, result } = renderHookWithProviders(() => useLinkRepositoryMutation());

    result.current.mutate({ factoryProjectId: 'fp-1', repo: gitlabRepo });

    await waitForMutationsIdle(client);
    expect(result.current.isSuccess).toBe(true);
    expect(requests).toEqual([
      { sourceId: 'gitlab-project:encoded' },
      { integrationId: 'gitlab', installationId: 'gitlab-inst-1' },
      {
        repository: { externalId: '10', slug: 'acme/app' },
        branch: 'main',
        sandboxProvider: 'local',
        sandboxWorkdir: '/workspace/app',
      },
    ]);
    expect(saved).toEqual([
      {
        github: { enabled: false, sourceIds: null },
        gitlab: { enabled: true, sourceIds: ['gitlab-project:encoded'] },
        clickup: { enabled: false, sourceIds: null },
      },
    ]);
  });

  it('given a GitHub repository, when it is linked, then the intake selection is left alone (the server adds its route)', async () => {
    stubRepositoryLink();
    const saved = stubIntakeConfig({
      github: { enabled: false, sourceIds: ['octo/other'] },
      gitlab: { enabled: false, sourceIds: null },
    });

    const { client, result } = renderHookWithProviders(() => useLinkRepositoryMutation());

    result.current.mutate({ factoryProjectId: 'fp-1', repo });

    await waitForMutationsIdle(client);
    expect(result.current.isSuccess).toBe(true);
    // Routes are what a project reads: the server's link handler adds the repository's route.
    expect(saved).toEqual([]);
  });

  it('given a repository already feeding issue intake, when it is linked again, then the selection is left alone', async () => {
    stubRepositoryLink();
    const saved = stubIntakeConfig({
      github: { enabled: true, sourceIds: ['octo/hello'] },
      gitlab: { enabled: false, sourceIds: null },
    });

    const { client, result } = renderHookWithProviders(() => useLinkRepositoryMutation());

    result.current.mutate({ factoryProjectId: 'fp-1', repo });

    await waitForMutationsIdle(client);
    expect(result.current.isSuccess).toBe(true);
    expect(saved).toEqual([]);
  });

});

describe('useFactoriesQuery', () => {
  it('loads every Factory with its linked repositories from the project list alone', async () => {
    const requested: string[] = [];
    const onRequest = ({ request }: { request: Request }) => {
      requested.push(new URL(request.url).pathname);
    };
    server.events.on('request:start', onRequest);
    onTestFinished(() => server.events.removeListener('request:start', onRequest));
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({
          projects: [
            {
              id: 'fp-1',
              name: 'Acme',
              repositories: [
                listedRepository('ghp_1', 'octo/hello', { branch: 'release', externalId: '99' }),
                listedRepository('glp_1', 'acme/app', {
                  integrationId: 'gitlab',
                  connectionId: 'conn-gl-1',
                  defaultBranch: 'trunk',
                  externalId: '10',
                }),
                listedRepository('ghp_2', 'unused', { slug: null, defaultBranch: null }),
              ],
            },
            { id: 'fp-2', name: 'Empty', repositories: [] },
          ],
        }),
      ),
    );

    const { result } = renderHookWithProviders(() => useFactoriesQuery());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map(({ id, repositories }) => ({ id, repositories }))).toEqual([
      {
        id: 'fp-1',
        repositories: [
          {
            projectRepositoryId: 'ghp_1',
            provider: 'github',
            externalId: '99',
            slug: 'octo/hello',
            gitBranch: 'release',
            sandboxWorkdir: '/workspace/octo/hello',
            inEnvironment: true,
            position: 1,
          },
          {
            projectRepositoryId: 'glp_1',
            provider: 'gitlab',
            externalId: '10',
            slug: 'acme/app',
            gitBranch: 'trunk',
            sandboxWorkdir: '/workspace/acme/app',
            inEnvironment: true,
            position: 1,
          },
          {
            projectRepositoryId: 'ghp_2',
            provider: 'github',
            externalId: undefined,
            slug: 'Acme',
            gitBranch: undefined,
            sandboxWorkdir: '/workspace/unused',
            inEnvironment: true,
            position: 1,
          },
        ],
      },
      { id: 'fp-2', repositories: [] },
    ]);
    expect(requested).toEqual(['/web/factory/projects']);
  });
});
