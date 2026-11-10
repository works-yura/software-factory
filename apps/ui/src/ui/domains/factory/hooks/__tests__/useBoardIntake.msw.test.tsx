/**
 * BDD coverage for the Intake swimlane's provider gating: a board only offers
 * a GitLab feed when one of that provider's sources is explicitly
 * bound to that board of the Factory project being viewed. Nothing is routed
 * implicitly.
 */
import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { builtinBoardCatalog, releaseBoard } from '../../../../../../e2e/ui/board-catalog';
import { server } from '../../../../../../e2e/ui/msw-server';
import { renderHookWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import type { LinkedRepositoryPayload } from '../../../workspaces/services/github';
import { queryKeys } from '../../../../../api/keys';
import type { InstalledBoardInfo } from '../../../../../api/types';
import type { GithubIssue } from '../../services/factory';
import type { GitLabIssue } from '../../services/gitlab';
import type { IntakeLabelRoute, IntakeSourceBinding } from '../../services/intake';
import { useBoardIntake } from '../useBoardIntake';
import { gitlabOnlyConfig, disabledGitlab } from './fixtures/query-loading';

const repository: LinkedRepositoryPayload = { projectRepositoryId: 'repo-1', slug: 'acme/app' };
const workBoard = builtinBoardCatalog.boards.find(board => board.id === 'work')!;

const gitlabIssue = (identifier: string, sourceId: string): GitLabIssue => ({
  id: identifier,
  externalId: `gitlab-issue:${identifier}`,
  identifier,
  title: `${identifier} title`,
  url: `https://gitlab.com/acme/app/-/issues/${identifier}`,
  state: 'opened',
  stateType: 'unstarted',
  priority: null,
  assignee: null,
  author: null,
  source: 'acme/app',
  sourceId,
  labels: [],
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-02T00:00:00Z',
});

function stubIntake(
  bindings: IntakeSourceBinding[],
  factoryIds: string[] = ['factory-1', 'factory-2'],
  issues: GitLabIssue[] = [],
) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: factoryIds.map(id => ({ id, name: id, repositories: [] })),
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({
        config: {
          github: { enabled: false, sourceIds: null },
          gitlab: { enabled: true, sourceIds: ['proj-1', 'proj-2'] },
        },
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/bindings`, () => HttpResponse.json({ bindings })),
    http.get(`${TEST_BASE_URL}/web/intake/label-routes`, () => HttpResponse.json({ routes: [] })),
    http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
      HttpResponse.json({ enabled: true, configured: true, reauthRequired: false }),
    ),
    http.get(`${TEST_BASE_URL}/web/gitlab/issues`, () => HttpResponse.json({ issues, nextCursor: null })),
    http.get(`${TEST_BASE_URL}/web/github/projects/repo-1/issues`, () => HttpResponse.json({ issues: [] })),
  );
}

const renderIntake = (
  factoryProjectId: string,
  definition: InstalledBoardInfo = workBoard,
  knownSourceKeys = new Set<string>(),
  elsewhereSourceKeys?: Set<string>,
) =>
  renderHookWithProviders(() =>
    useBoardIntake({ factoryProjectId, repositories: [repository], definition, knownSourceKeys, elsewhereSourceKeys }),
  );

describe('useBoardIntake GitLab gating', () => {
  it('given a source bound to Work on the viewed project, when the board loads, then the GitLab feed is offered', async () => {
    stubIntake([{ integrationId: 'gitlab', sourceId: 'proj-1', factoryProjectId: 'factory-1', board: 'work' }]);

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.available).toContain('gitlab'));
  });

  it('reports a failed binding load instead of treating it as nothing bound', async () => {
    stubIntake([]);
    server.use(
      http.get(`${TEST_BASE_URL}/web/intake/bindings`, () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
    );

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.available).toEqual(['gitlab']);
    expect(result.current.candidates).toEqual([]);
    expect(result.current.feedByColumn.intake?.error).toBeInstanceOf(Error);
  });

  it('keeps a GitLab-eligible board pending until its bindings have loaded', async () => {
    const binding: IntakeSourceBinding = {
      integrationId: 'gitlab',
      sourceId: 'proj-1',
      factoryProjectId: 'factory-1',
      board: 'work',
    };
    stubIntake([binding]);
    let releaseBindings: () => void = () => {};
    const bindingsRequested = new Promise<void>(resolve => {
      server.use(
        http.get(`${TEST_BASE_URL}/web/intake/bindings`, async () => {
          resolve();
          await new Promise<void>(release => (releaseBindings = release));
          return HttpResponse.json({ bindings: [binding] });
        }),
      );
    });

    const { result } = renderIntake('factory-1');

    await bindingsRequested;
    // Config may already be in; bindings are not. Either way the board must
    // not present itself as a settled, feed-less board.
    expect(result.current.available).not.toContain('gitlab');
    expect(result.current.isPending).toBe(true);

    releaseBindings();
    await waitFor(() => expect(result.current.available).toContain('gitlab'));
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it('given the source is bound to another Factory, when the board loads, then the GitLab feed is withheld', async () => {
    stubIntake([{ integrationId: 'gitlab', sourceId: 'proj-1', factoryProjectId: 'factory-1', board: 'work' }]);

    const { result } = renderIntake('factory-2');

    await waitFor(() => expect(result.current.available).toEqual([]));
    expect(result.current.available).not.toContain('gitlab');
  });

  it('given a source routed to the Factory without a board, when Work loads, then the GitLab feed is withheld', async () => {
    stubIntake(
      [{ integrationId: 'gitlab', sourceId: 'proj-1', factoryProjectId: 'factory-1', board: null }],
      ['factory-1'],
    );

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.available).toEqual([]);
  });

  it('given no bindings and a single Factory, when the board loads, then the GitLab feed is still withheld', async () => {
    stubIntake([], ['factory-1']);

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.available).toEqual([]);
  });
});

describe('useBoardIntake board-bound sources', () => {
  const bindings: IntakeSourceBinding[] = [
    { integrationId: 'gitlab', sourceId: 'proj-1', factoryProjectId: 'factory-1', board: 'work' },
    { integrationId: 'gitlab', sourceId: 'proj-2', factoryProjectId: 'factory-1', board: 'release' },
  ];
  const issues = [gitlabIssue('ENG-1', 'proj-1'), gitlabIssue('REL-1', 'proj-2')];

  it('offers a custom board only the issues bound to it, on its initial phase', async () => {
    stubIntake(bindings, ['factory-1'], issues);

    const { result } = renderIntake('factory-1', releaseBoard);

    await waitFor(() => expect(result.current.active).toBe('gitlab'));
    await waitFor(() => expect(result.current.candidates).toHaveLength(1));
    expect(result.current.candidates[0]).toMatchObject({ sourceKey: 'gitlab-issue:REL-1', column: 'queued' });
    expect(result.current.feedByColumn).toHaveProperty('queued');
    expect(result.current.feedByColumn).not.toHaveProperty('intake');
  });

  it('keeps issues bound to another board off Work', async () => {
    stubIntake(bindings, ['factory-1'], issues);

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.active).toBe('gitlab'));
    await waitFor(() => expect(result.current.candidates).toHaveLength(1));
    expect(result.current.candidates[0]).toMatchObject({ sourceKey: 'gitlab-issue:ENG-1', column: 'intake' });
  });

  it('counts feed items held back only when their card sits on another board', async () => {
    stubIntake(bindings, ['factory-1'], issues);
    const known = new Set(['gitlab-issue:REL-1']);

    const elsewhere = renderIntake('factory-1', releaseBoard, known, known);
    await waitFor(() => expect(elsewhere.result.current.isPending).toBe(false));
    expect(elsewhere.result.current.candidates).toEqual([]);
    expect(elsewhere.result.current.alreadyMaterialized).toBe(1);

    // The same card on this board is already visible in a column; nothing to explain.
    const here = renderIntake('factory-1', releaseBoard, known, new Set());
    await waitFor(() => expect(here.result.current.isPending).toBe(false));
    expect(here.result.current.candidates).toEqual([]);
    expect(here.result.current.alreadyMaterialized).toBe(0);
  });

  it('withholds the GitLab feed from a custom board with nothing bound to it', async () => {
    stubIntake([bindings[0]], ['factory-1'], issues);

    const { result } = renderIntake('factory-1', releaseBoard);

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.available).toEqual([]);
  });
});

describe('useBoardIntake GitLab routing', () => {
  it('never queries GitHub issues or label routes for a GitLab-linked Work board', async () => {
    const sourceId = 'gitlab-project:encoded-source';
    let githubIssueRequests = 0;
    let githubLabelRouteRequests = 0;
    server.use(
      http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
        HttpResponse.json({
          config: {
            github: { enabled: false, sourceIds: [] },
            gitlab: { enabled: true, sourceIds: [sourceId] },
          },
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/intake/bindings`, () =>
        HttpResponse.json({
          bindings: [{ integrationId: 'gitlab', sourceId, factoryProjectId: 'factory-1', board: 'work' }],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({ enabled: true, configured: true, reauthRequired: false }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/issues`, () => HttpResponse.json({ issues: [], nextCursor: null })),
      http.get(`${TEST_BASE_URL}/web/github/projects/repo-1/issues`, () => {
        githubIssueRequests++;
        return HttpResponse.json({ issues: [], nextPage: null });
      }),
      http.get(`${TEST_BASE_URL}/web/intake/label-routes`, () => {
        githubLabelRouteRequests++;
        return HttpResponse.json({ routes: [] });
      }),
    );

    const { result } = renderHookWithProviders(() =>
      useBoardIntake({
        factoryProjectId: 'factory-1',
        repositories: [{ ...repository, provider: 'gitlab' }],
        definition: workBoard,
        knownSourceKeys: new Set(),
      }),
    );

    await waitFor(() => expect(result.current.active).toBe('gitlab'));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(githubIssueRequests).toBe(0);
    expect(githubLabelRouteRequests).toBe(0);
  });

  it('uses the GitLab MR feed for a GitLab-linked Work board and never requests GitHub PRs', async () => {
    stubIntake([]);
    let githubRequests = 0;
    server.use(
      http.get(`${TEST_BASE_URL}/web/gitlab/projects/repo-1/prs`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('factoryProjectId')).toBe('factory-1');
        expect(url.searchParams.get('page')).toBe('1');
        return HttpResponse.json({
          pullRequests: [
            {
              number: 5,
              externalId: 'gitlab-pr:encoded-5',
              title: 'Validate GitLab',
              url: 'https://gitlab.com/acme/app/-/merge_requests/5',
              author: 'rhys',
              assignees: [],
              requestedReviewers: [],
              baseBranch: 'main',
              headBranch: 'test-branch',
              createdAt: '2026-09-18T00:00:00Z',
              updatedAt: '2026-09-18T00:00:00Z',
            },
          ],
          nextPage: null,
        });
      }),
      http.get(`${TEST_BASE_URL}/web/github/projects/repo-1/prs`, () => {
        githubRequests++;
        return HttpResponse.json({ pullRequests: [], nextPage: null });
      }),
    );
    const { result } = renderHookWithProviders(() =>
      useBoardIntake({
        factoryProjectId: 'factory-1',
        repositories: [{ ...repository, provider: 'gitlab' }],
        definition: workBoard,
        knownSourceKeys: new Set(),
      }),
    );

    await waitFor(() => expect(result.current.candidates).toHaveLength(1));
    expect(result.current.active).toBe('gitlab-prs');
    expect(result.current.candidates[0]).toMatchObject({ source: 'gitlab-pr', sourceKey: 'gitlab-pr:encoded-5' });
    expect(githubRequests).toBe(0);
  });

  it('shows a routed GitLab issue on its destination board', async () => {
    const sourceId = 'gitlab-project:encoded-source';
    const issue: GitLabIssue = {
      id: '42',
      externalId: 'gitlab-issue:encoded-42',
      identifier: 'acme/app#42',
      title: 'Fix GitLab intake',
      url: 'https://gitlab.com/acme/app/-/issues/42',
      state: 'opened',
      stateType: 'unstarted',
      priority: null,
      assignee: 'ada',
      author: 'grace',
      source: 'acme/app',
      sourceId,
      labels: ['bug'],
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
    };
    server.use(
      http.get(TEST_BASE_URL + '/web/intake/config', () =>
        HttpResponse.json({
          config: {
            github: { enabled: false, sourceIds: null },
            gitlab: { enabled: true, sourceIds: [sourceId] },
          },
        }),
      ),
      http.get(TEST_BASE_URL + '/web/intake/bindings', () =>
        HttpResponse.json({
          bindings: [{ integrationId: 'gitlab', sourceId, factoryProjectId: 'factory-1', board: 'release' }],
        }),
      ),
      http.get(TEST_BASE_URL + '/web/intake/label-routes', () => HttpResponse.json({ routes: [] })),
      http.get(TEST_BASE_URL + '/web/gitlab/status', () =>
        HttpResponse.json({ enabled: true, configured: true, reauthRequired: false }),
      ),
      http.get(TEST_BASE_URL + '/web/gitlab/issues', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('factoryProjectId')).toBe('factory-1');
        expect(url.searchParams.get('board')).toBe('release');
        return HttpResponse.json({ issues: [issue], nextCursor: null });
      }),
    );

    const { result } = renderIntake('factory-1', releaseBoard);

    await waitFor(() => expect(result.current.active).toBe('gitlab'));
    await waitFor(() => expect(result.current.candidates).toHaveLength(1));
    expect(result.current.candidates[0]).toMatchObject({
      source: 'gitlab-issue',
      sourceKey: issue.externalId,
      column: 'queued',
    });
  });
});

describe('useBoardIntake GitHub label routes', () => {
  const githubIssue = (number: number, labels: string[]): GithubIssue => ({
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/app/issues/${number}`,
    author: 'octocat',
    labels,
    comments: 0,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
  });
  const issues = [githubIssue(1, ['bug']), githubIssue(2, ['Release']), githubIssue(3, [])];

  function stubGithub(routes: IntakeLabelRoute[]) {
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: 'factory-1', name: 'factory-1', repositories: [] }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
        HttpResponse.json({
          config: { github: { enabled: true, sourceIds: ['acme/app'] } },
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/intake/bindings`, () => HttpResponse.json({ bindings: [] })),
      http.get(`${TEST_BASE_URL}/web/intake/label-routes`, ({ request }) => {
        const factoryProjectId = new URL(request.url).searchParams.get('factoryProjectId');
        return HttpResponse.json({ routes: routes.filter(route => route.factoryProjectId === factoryProjectId) });
      }),
      http.get(`${TEST_BASE_URL}/web/github/projects/repo-1/issues`, ({ request }) =>
        HttpResponse.json({
          issues: new URL(request.url).searchParams.get('label') ? [] : issues,
          nextCursor: null,
        }),
      ),
    );
  }
  const releaseRoute: IntakeLabelRoute = {
    factoryProjectId: 'factory-1',
    integrationId: 'github',
    label: 'release',
    board: 'release',
  };

  it('offers a custom board the issues carrying its routed label, on its initial phase', async () => {
    stubGithub([releaseRoute]);

    const { result } = renderIntake('factory-1', releaseBoard);

    await waitFor(() => expect(result.current.active).toBe('github'));
    await waitFor(() => expect(result.current.candidates).toHaveLength(1));
    expect(result.current.candidates[0]).toMatchObject({ sourceKey: 'github-issue:2', column: 'queued' });
    expect(result.current.feedByColumn).toHaveProperty('queued');
    expect(result.current.feedByColumn).not.toHaveProperty('triage');
  });

  it('keeps routed issues off Work while unrouted ones stay', async () => {
    stubGithub([releaseRoute]);

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.active).toBe('github'));
    await waitFor(() => expect(result.current.candidates).toHaveLength(2));
    expect(result.current.candidates.map(candidate => candidate.sourceKey)).toEqual([
      'github-issue:1',
      'github-issue:3',
    ]);
  });

  it('withholds the GitHub feed from a custom board with no label routed to it', async () => {
    stubGithub([]);

    const { result } = renderIntake('factory-1', releaseBoard);

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.available).toEqual([]);
  });

  it('keeps a custom board pending until its label routes have loaded', async () => {
    stubGithub([releaseRoute]);
    let releaseRoutes: () => void = () => {};
    const routesRequested = new Promise<void>(resolve => {
      server.use(
        http.get(`${TEST_BASE_URL}/web/intake/label-routes`, async () => {
          resolve();
          await new Promise<void>(release => (releaseRoutes = release));
          return HttpResponse.json({ routes: [releaseRoute] });
        }),
      );
    });

    const { result } = renderIntake('factory-1', releaseBoard);

    // Routes are in flight (the handler is holding the request): the board
    // must report pending rather than an empty feed.
    await routesRequested;
    expect(result.current.available).toEqual([]);
    expect(result.current.isPending).toBe(true);

    releaseRoutes();
    await waitFor(() => expect(result.current.candidates).toHaveLength(1));
    expect(result.current.isPending).toBe(false);
  });

  it('reports a failed label-route load instead of treating every issue as Work', async () => {
    stubGithub([releaseRoute]);
    server.use(
      http.get(`${TEST_BASE_URL}/web/intake/label-routes`, () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
    );

    const work = renderIntake('factory-1');
    await waitFor(() => expect(work.result.current.isPending).toBe(false));
    expect(work.result.current.candidates).toEqual([]);
    expect(work.result.current.feedByColumn.intake?.error).toBeInstanceOf(Error);

    const release = renderIntake('factory-1', releaseBoard);
    await waitFor(() => expect(release.result.current.isPending).toBe(false));
    expect(release.result.current.candidates).toEqual([]);
    expect(release.result.current.feedByColumn.queued?.error).toBeInstanceOf(Error);
  });
});

describe('useBoardIntake query loading', () => {
  describe('when intake configuration is still loading', () => {
    it('starts GitLab status before configuration resolves', async () => {
      stubIntake([]);
      let release = () => {};
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      let requested = false;
      server.use(
        http.get(`${TEST_BASE_URL}/web/intake/config`, async () => {
          await held;
          return HttpResponse.json({ config: gitlabOnlyConfig });
        }),
        http.get(`${TEST_BASE_URL}/web/gitlab/status`, () => {
          requested = true;
          return HttpResponse.json(disabledGitlab);
        }),
      );
      const { unmount } = renderIntake('factory-1');
      try {
        await waitFor(() => expect(requested).toBe(true));
      } finally {
        release();
        unmount();
      }
    });
  });
});

describe('useBoardIntake across linked repositories', () => {
  const repositories: LinkedRepositoryPayload[] = [
    { projectRepositoryId: 'repo-1', slug: 'acme/app', externalId: '1' },
    { projectRepositoryId: 'repo-2', slug: 'acme/api', externalId: '2' },
    { projectRepositoryId: 'repo-3', slug: 'acme/docs', externalId: '3' },
  ];
  const issueIn = (repositoryId: number, number: number): GithubIssue => ({
    repositoryId,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/repo-${repositoryId}/issues/${number}`,
    author: 'octocat',
    labels: [],
    comments: 0,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
  });
  const pullIn = (repositoryId: number, number: number) => ({
    repositoryId,
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/repo-${repositoryId}/pull/${number}`,
    author: 'octocat',
    baseBranch: 'main',
    headBranch: `feat/${number}`,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
  });

  function stubRepositories(requested: string[]) {
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: 'factory-1', name: 'factory-1', repositories: [] }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
        HttpResponse.json({
          config: {
            github: { enabled: true, sourceIds: ['acme/app', 'acme/api'] },
          },
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/intake/bindings`, () => HttpResponse.json({ bindings: [] })),
      http.get(`${TEST_BASE_URL}/web/intake/label-routes`, () => HttpResponse.json({ routes: [] })),
      http.get(`${TEST_BASE_URL}/web/github/projects/:id/issues`, ({ params, request }) => {
        const id = String(params.id);
        const labelled = new URL(request.url).searchParams.get('label');
        if (!labelled) requested.push(`issues:${id}`);
        const repositoryId = Number(id.replace('repo-', ''));
        return HttpResponse.json({ issues: labelled ? [] : [issueIn(repositoryId, 5)], nextPage: null });
      }),
      http.get(`${TEST_BASE_URL}/web/github/projects/:id/prs`, ({ params }) => {
        const id = String(params.id);
        requested.push(`prs:${id}`);
        return HttpResponse.json({ pullRequests: [pullIn(Number(id.replace('repo-', '')), 9)], nextPage: null });
      }),
    );
  }

  it('offers Work the issues of every repository selected as an issue source, kept apart by repository', async () => {
    stubRepositories([]);

    const { result } = renderHookWithProviders(() =>
      useBoardIntake({
        factoryProjectId: 'factory-1',
        repositories,
        definition: workBoard,
        knownSourceKeys: new Set(),
      }),
    );

    await waitFor(() => expect(result.current.candidates).toHaveLength(5));
    expect(
      result.current.candidates.filter(candidate => candidate.source === 'github-issue').map(c => c.sourceKey),
    ).toEqual(['github:1:issue:5', 'github:2:issue:5']);
  });

  it('offers Work the pull requests of every linked GitHub repository, filed onto its Intake', async () => {
    const requested: string[] = [];
    stubRepositories(requested);

    const { result } = renderHookWithProviders(() =>
      useBoardIntake({
        factoryProjectId: 'factory-1',
        repositories,
        definition: workBoard,
        knownSourceKeys: new Set(),
      }),
    );

    await waitFor(() => expect(result.current.candidates).toHaveLength(5));
    const pullRequests = result.current.candidates.filter(candidate => candidate.source === 'github-pr');
    expect(pullRequests.map(candidate => [candidate.sourceKey, candidate.column])).toEqual([
      ['github:1:pull-request:9', 'intake'],
      ['github:2:pull-request:9', 'intake'],
      ['github:3:pull-request:9', 'intake'],
    ]);
    // Pull requests are not an issue source: Work still lists only its issue feeds.
    expect(result.current.available).toEqual(['github']);
    expect(requested).toEqual(expect.arrayContaining(['prs:repo-1', 'prs:repo-2', 'prs:repo-3']));
  });

  it('drops a second repository candidate that is already a card without hiding the first repository one', async () => {
    stubRepositories([]);

    const { result } = renderHookWithProviders(() =>
      useBoardIntake({
        factoryProjectId: 'factory-1',
        repositories,
        definition: workBoard,
        knownSourceKeys: new Set(['github:2:issue:5']),
      }),
    );

    await waitFor(() => expect(result.current.candidates).toHaveLength(4));
    expect(result.current.candidates.filter(candidate => candidate.source === 'github-issue')).toEqual([
      expect.objectContaining({ sourceKey: 'github:1:issue:5' }),
    ]);
  });
});
