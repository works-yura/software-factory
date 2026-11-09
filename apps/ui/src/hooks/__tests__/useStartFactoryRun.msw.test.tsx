import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { listedRepository } from '../../../e2e/ui/factory-projects';
import { server } from '../../../e2e/ui/msw-server';
import { renderHookWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import { providerFactsCard } from '../../ui/__tests__/fixtures/providerFactsCard';
import { useStartFactoryRun } from '../useStartFactoryRun';
import type { StartFactoryRunWorkItem } from '../useStartFactoryRun';

const FACTORY_ID = 'fp-1';

function RouteInner({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}`]}>
      <Routes>
        <Route path="/factories/:factoryId" element={children} />
      </Routes>
    </MemoryRouter>
  );
}

function stubEndpoints(
  repositories: Array<{
    id: string;
    externalId: string;
    slug: string;
    provider?: 'github' | 'gitlab';
    inEnvironment?: boolean;
    position?: number;
  }>,
) {
  const sessionsCreatedFor: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  let started: Record<string, unknown> | undefined;
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: FACTORY_ID,
            name: 'Acme Factory',
            repositories: repositories.map(repository =>
              listedRepository(repository.id, repository.slug, {
                integrationId: repository.provider ?? 'github',
                externalId: repository.externalId,
                branch: 'main',
                sandboxWorkdir: '/repo',
                ...(repository.inEnvironment === undefined ? {} : { inEnvironment: repository.inEnvironment }),
                ...(repository.position === undefined ? {} : { position: repository.position }),
              }),
            ),
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({ config: { github: { enabled: true, sourceIds: [] } } }),
    ),
    http.patch(`${TEST_BASE_URL}/web/factory/work-items/:id`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      return HttpResponse.json({
        workItem: {
          id: 'item-1',
          factoryProjectId: FACTORY_ID,
          externalSource: null,
          title: 'Fix login bug',
          stages: ['intake'],
          stageHistory: [],
          sessions: {},
          metadata: body.metadata,
          revision: 2,
          createdAt: '2026-07-18T00:00:00.000Z',
          updatedAt: '2026-07-18T00:00:00.000Z',
        },
      });
    }),
    http.post(`${TEST_BASE_URL}/web/source-control/projects/:projectRepositoryId/sessions`, ({ params }) => {
      sessionsCreatedFor.push(String(params.projectRepositoryId));
      return HttpResponse.json({ session: { sessionId: 'session-1', branch: 'factory/item-1', title: null } });
    }),
    http.post(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/runs/start`, async ({ request }) => {
      started = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ prepared: { threadId: 'thread-1' } });
    }),
  );
  return { sessionsCreatedFor, patches, started: () => started };
}

const workItem: StartFactoryRunWorkItem = {
  id: 'item-1',
  role: 'work',
  source: 'github-issue' as const,
  sourceKey: 'github-issue:7',
  title: 'Fix login bug',
  // The card was filed before the repository was renamed from acme/old-name.
  metadata: { number: 7, repository: 'acme/old-name', githubRepositoryId: 101 },
};

describe.each(['github', 'gitlab'] as const)('useStartFactoryRun with %s', provider => {
  it.each([
    ['a single linked repository', [{ id: 'repo-1', externalId: '101', slug: 'acme/renamed' }]],
    [
      'several linked repositories',
      [
        { id: 'repo-2', externalId: '202', slug: 'acme/other' },
        { id: 'repo-1', externalId: '101', slug: 'acme/renamed' },
      ],
    ],
  ])('starts a renamed repository card by its normalized provider id with %s', async (_label, repositories) => {
    const providerWorkItem: StartFactoryRunWorkItem = {
      ...workItem,
      source: provider === 'github' ? 'github-issue' : 'gitlab-issue',
      sourceKey: `${provider}-issue:7`,
      metadata: {
        number: 7,
        repository: 'acme/old-name',
        githubRepositoryId: 202,
        gitlabProjectId: '202',
        labels: ['stale-label'],
        state: 'closed',
      },
      workItem: {
        ...providerFactsCard.workItem,
        metadata: provider === 'github' ? { githubRepositoryId: 101 } : { gitlabProjectId: '101' },
      },
    };
    const calls = stubEndpoints(repositories.map(repository => ({ ...repository, provider })));
    const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    await result.current.start.mutateAsync({
      branch: 'factory/item-1',
      threadTitle: 'Fix login bug',
      workItem: providerWorkItem,
    });

    expect(calls.sessionsCreatedFor).toEqual(['repo-1']);
    expect(calls.patches).toEqual([{ metadata: { repository: 'acme/renamed' } }]);
    expect(calls.started()).toHaveProperty('workItem.input.metadata', { repository: 'acme/renamed' });
  });
});

describe.each(['github-issue', 'github-pr', 'gitlab-issue', 'gitlab-pr'] as const)(
  'useStartFactoryRun provider selection for %s',
  source => {
    const provider = source.startsWith('github-') ? 'github' : 'gitlab';
    const otherProvider = provider === 'github' ? 'gitlab' : 'github';

    it.each(['sole repository fallback', 'stored slug'])(
      'rejects the other provider via %s before any writes',
      async selection => {
        const calls = stubEndpoints([
          { id: 'other-repo', provider: otherProvider, externalId: '101', slug: 'acme/other' },
        ]);
        const providerWorkItem: StartFactoryRunWorkItem = {
          ...workItem,
          source,
          metadata: {
            githubRepositoryId: 101,
            gitlabProjectId: '101',
            ...(selection === 'stored slug' ? { repository: 'acme/other' } : {}),
          },
        };
        const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
        await waitFor(() => expect(result.current.enabled).toBe(true));

        await expect(
          result.current.start.mutateAsync({
            branch: 'factory/item-1',
            threadTitle: 'Fix login bug',
            workItem: providerWorkItem,
          }),
        ).rejects.toThrow('Turn a repository on under Settings → Environment before starting this Factory run');

        expect(calls.sessionsCreatedFor).toEqual([]);
        expect(calls.patches).toEqual([]);
        expect(calls.started()).toBeUndefined();
      },
    );

    it('chooses the source provider when linked repositories share a slug', async () => {
      const calls = stubEndpoints([
        { id: 'other-repo', provider: otherProvider, externalId: '101', slug: 'acme/shared' },
        { id: 'source-repo', provider, externalId: '101', slug: 'acme/shared' },
      ]);
      const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
      await waitFor(() => expect(result.current.enabled).toBe(true));

      await result.current.start.mutateAsync({
        branch: 'factory/item-1',
        threadTitle: 'Fix login bug',
        workItem: { ...workItem, source, metadata: { githubRepositoryId: 101, gitlabProjectId: '101' } },
      });

      expect(calls.sessionsCreatedFor).toEqual(['source-repo']);
      expect(calls.started()).toMatchObject({ workItem: { input: { metadata: { repository: 'acme/shared' } } } });
    });

    it('keeps the sole-repository fallback for the same provider without metadata', async () => {
      const calls = stubEndpoints([{ id: 'source-repo', provider, externalId: '101', slug: 'acme/source' }]);
      const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
      await waitFor(() => expect(result.current.enabled).toBe(true));

      await result.current.start.mutateAsync({
        branch: 'factory/item-1',
        threadTitle: 'Fix login bug',
        workItem: { ...workItem, source, metadata: undefined },
      });

      expect(calls.sessionsCreatedFor).toEqual(['source-repo']);
      // The card names no repository and stays unbound: adding a second
      // repository later widens its workspace instead of pinning it here.
      expect(calls.patches).toEqual([]);
      expect(calls.started()).toMatchObject({ workItem: { input: { metadata: {} } } });
    });
  },
);

describe.each(['manual'] as const)('useStartFactoryRun fallback for %s', source => {
  it.each(['github', 'gitlab'] as const)('keeps the sole %s repository fallback', async provider => {
    const calls = stubEndpoints([{ id: 'repo-1', provider, externalId: '101', slug: 'acme/one' }]);
    const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    await result.current.start.mutateAsync({
      branch: 'factory/item-1',
      threadTitle: 'Fix login bug',
      workItem: { ...workItem, source, metadata: undefined },
    });

    expect(calls.sessionsCreatedFor).toEqual(['repo-1']);
    expect(calls.patches).toEqual([]);
    expect(calls.started()).toMatchObject({ workItem: { input: { metadata: {} } } });
  });

  it('runs a card that names no repository across every environment repository, choosing none', async () => {
    const calls = stubEndpoints([
      { id: 'backend', provider: 'gitlab', externalId: '1', slug: 'works_yura/ai', inEnvironment: true, position: 1 },
      { id: 'app', provider: 'gitlab', externalId: '2', slug: 'works_yura/test', inEnvironment: true, position: 0 },
      { id: 'parked', provider: 'gitlab', externalId: '3', slug: 'works_yura/old', inEnvironment: false, position: -1 },
    ]);
    const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    await result.current.start.mutateAsync({
      branch: 'factory/item-1',
      threadTitle: 'Fix login bug',
      workItem: { ...workItem, source, metadata: undefined },
    });

    // Filed under the first environment repository; the card itself is not
    // bound to it, the sandbox boots both.
    expect(calls.sessionsCreatedFor).toEqual(['app']);
    expect(calls.patches).toEqual([]);
    const started = calls.started()?.workItem as { input: { metadata: Record<string, unknown> } };
    expect(started.input.metadata).not.toHaveProperty('repository');
  });

  it('refuses to start when several repositories are linked but none is in the environment', async () => {
    const calls = stubEndpoints([
      { id: 'one', provider: 'gitlab', externalId: '1', slug: 'works_yura/ai', inEnvironment: false },
      { id: 'two', provider: 'gitlab', externalId: '2', slug: 'works_yura/test', inEnvironment: false },
    ]);
    const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    await expect(
      result.current.start.mutateAsync({
        branch: 'factory/item-1',
        threadTitle: 'Fix login bug',
        workItem: { ...workItem, source, metadata: undefined },
      }),
    ).rejects.toThrow('Turn a repository on under Settings → Environment before starting this Factory run');
    expect(calls.sessionsCreatedFor).toEqual([]);
  });
});

describe('useStartFactoryRun in a mixed-provider factory', () => {
  describe.each(['github', 'gitlab'] as const)('a %s card with both provider ids', provider => {
    it.each(['both match', 'only the other provider matches'])(
      'creates the session in the source provider when %s',
      async matchCase => {
        const otherProvider = provider === 'github' ? 'gitlab' : 'github';
        const targetSlug = `acme/${provider}-renamed`;
        const providerWorkItem: StartFactoryRunWorkItem = {
          ...workItem,
          source: provider === 'github' ? 'github-issue' : 'gitlab-issue',
          sourceKey: `${provider}-issue:7`,
          metadata: {
            ...workItem.metadata,
            repository: matchCase === 'both match' ? 'acme/old-name' : targetSlug,
            githubRepositoryId: 101,
            gitlabProjectId: '101',
          },
        };
        const calls = stubEndpoints([
          { id: 'other-repo', provider: otherProvider, externalId: '101', slug: `acme/${otherProvider}` },
          {
            id: 'source-repo',
            provider,
            externalId: matchCase === 'both match' ? '101' : '999',
            slug: targetSlug,
          },
        ]);
        const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
        await waitFor(() => expect(result.current.enabled).toBe(true));

        await result.current.start.mutateAsync({
          branch: 'factory/item-1',
          threadTitle: 'Fix login bug',
          workItem: providerWorkItem,
        });

        expect(calls.sessionsCreatedFor).toEqual(['source-repo']);
        expect(calls.patches).toEqual(
          matchCase === 'both match' ? [{ metadata: { ...providerWorkItem.metadata, repository: targetSlug } }] : [],
        );
        expect(calls.started()).toMatchObject({
          workItem: { input: { metadata: { ...providerWorkItem.metadata, repository: targetSlug } } },
        });
      },
    );
  });

  it('starts in GitHub when GitLab has the same external id', async () => {
    const calls = stubEndpoints([
      { id: 'gitlab-repo', provider: 'gitlab', externalId: '101', slug: 'acme/gitlab' },
      { id: 'github-repo', provider: 'github', externalId: '101', slug: 'acme/renamed' },
    ]);
    const { result } = renderHookWithProviders(() => useStartFactoryRun(), { inner: RouteInner });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    await result.current.start.mutateAsync({ branch: 'factory/item-1', threadTitle: 'Fix login bug', workItem });

    expect(calls.sessionsCreatedFor).toEqual(['github-repo']);
    expect(calls.patches).toEqual([{ metadata: { ...workItem.metadata, repository: 'acme/renamed' } }]);
  });
});
