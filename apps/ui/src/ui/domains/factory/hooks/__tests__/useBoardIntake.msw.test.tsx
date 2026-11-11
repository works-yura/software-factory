/**
 * BDD coverage for the Intake swimlane's provider gating: every new card is filed
 * on the default board before the project's intake routes place it, so only Work
 * offers feeds, and a GitLab feed only once a route of the Factory project being
 * viewed names one of its linked GitLab projects.
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
import { useBoardIntake } from '../useBoardIntake';
import { gitlabOnlyConfig, disabledGitlab } from './fixtures/query-loading';

const repository: LinkedRepositoryPayload = { projectRepositoryId: 'repo-1', slug: 'acme/app' };
/** A GitLab project linked to the Factory project alongside the GitHub one. */
const gitlabRepository: LinkedRepositoryPayload = { projectRepositoryId: 'repo-gl', slug: 'acme/gl', provider: 'gitlab' };

/** A route of the Factory project subscribing it to the GitLab project at `path`. */
const gitlabRoute = (path: string, position = 0) => ({
  id: `route-${path}`,
  name: `GitLab: ${path}`,
  enabled: true,
  position,
  on: ['work_item.created'],
  when: {
    operator: 'AND',
    conditions: [
      { field: 'source.integration', operator: 'equals', value: 'gitlab' },
      { field: 'source.repository', operator: 'equals', value: path },
    ],
  },
  target: { boardKey: 'work', phaseKey: null },
});

const ROUTES_URL = `${TEST_BASE_URL}/web/factory/projects/:id/intake-routes`;
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
  /** The GitLab project paths each Factory project's routes name. */
  routed: Record<string, string[]>,
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
    http.get(ROUTES_URL, ({ params }) =>
      HttpResponse.json({ intakeRoutes: (routed[String(params.id)] ?? []).map(path => gitlabRoute(path)) }),
    ),
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
    useBoardIntake({
      factoryProjectId,
      repositories: [repository, gitlabRepository],
      definition,
      knownSourceKeys,
      elsewhereSourceKeys,
    }),
  );

describe('useBoardIntake GitLab gating', () => {
  it('given a route of the viewed project naming a linked GitLab project, then the GitLab feed is offered', async () => {
    stubIntake({ 'factory-1': ['acme/gl'] });

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.available).toContain('gitlab'));
  });

  it('reports a failed route load instead of treating it as nothing routed', async () => {
    stubIntake({});
    server.use(http.get(ROUTES_URL, () => HttpResponse.json({ error: 'nope' }, { status: 500 })));

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.available).toEqual(['gitlab']);
    expect(result.current.candidates).toEqual([]);
    expect(result.current.feedByColumn.intake?.error).toBeInstanceOf(Error);
  });

  it('keeps a GitLab-eligible board pending until its routes have loaded', async () => {
    stubIntake({});
    let releaseRoutes: () => void = () => {};
    const routesRequested = new Promise<void>(resolve => {
      server.use(
        http.get(ROUTES_URL, async () => {
          resolve();
          await new Promise<void>(release => (releaseRoutes = release));
          return HttpResponse.json({ intakeRoutes: [gitlabRoute('acme/gl')] });
        }),
      );
    });

    const { result } = renderIntake('factory-1');

    await routesRequested;
    // Config may already be in; the routes are not. Either way the board must
    // not present itself as a settled, feed-less board.
    expect(result.current.available).not.toContain('gitlab');
    expect(result.current.isPending).toBe(true);

    releaseRoutes();
    await waitFor(() => expect(result.current.available).toContain('gitlab'));
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it('given only another Factory routes the GitLab project, when the board loads, then the GitLab feed is withheld', async () => {
    stubIntake({ 'factory-1': ['acme/gl'] });

    const { result } = renderIntake('factory-2');

    await waitFor(() => expect(result.current.available).toEqual([]));
    expect(result.current.available).not.toContain('gitlab');
  });

  it('given a route naming a GitLab project that is not linked here, then the GitLab feed is withheld', async () => {
    stubIntake({ 'factory-1': ['acme/unlinked'] }, ['factory-1']);

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.available).toEqual([]);
  });

  it('given no GitLab route and a single Factory, when the board loads, then the GitLab feed is still withheld', async () => {
    stubIntake({}, ['factory-1']);

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.available).toEqual([]);
  });
});

describe('useBoardIntake sources routed to the project', () => {
  const routed = { 'factory-1': ['acme/gl'] };
  const issues = [gitlabIssue('ENG-1', 'proj-1'), gitlabIssue('REL-1', 'proj-2')];

  it("offers Work the routed projects' issues on its Intake: the routes place them once filed", async () => {
    stubIntake(routed, ['factory-1'], issues);

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.active).toBe('gitlab'));
    await waitFor(() => expect(result.current.candidates).toHaveLength(2));
    expect(result.current.candidates.map(candidate => candidate.column)).toEqual(['intake', 'intake']);
  });

  it('counts feed items held back only when their card sits on another board', async () => {
    stubIntake(routed, ['factory-1'], issues);
    const known = new Set(['gitlab-issue:REL-1']);

    const elsewhere = renderIntake('factory-1', workBoard, known, known);
    await waitFor(() => expect(elsewhere.result.current.isPending).toBe(false));
    await waitFor(() => expect(elsewhere.result.current.candidates).toHaveLength(1));
    expect(elsewhere.result.current.alreadyMaterialized).toBe(1);

    // The same card on this board is already visible in a column; nothing to explain.
    const here = renderIntake('factory-1', workBoard, known, new Set());
    await waitFor(() => expect(here.result.current.isPending).toBe(false));
    await waitFor(() => expect(here.result.current.candidates).toHaveLength(1));
    expect(here.result.current.alreadyMaterialized).toBe(0);
  });

  it('offers a custom board no provider feed: new cards reach it through intake routes', async () => {
    stubIntake(routed, ['factory-1'], issues);

    const { result } = renderIntake('factory-1', releaseBoard);

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.available).toEqual([]);
    expect(result.current.candidates).toEqual([]);
  });
});

describe('useBoardIntake ClickUp through routes', () => {
  const clickupRoute = (boardKey: string, list: string) => ({
    id: `route-${list}`,
    name: 'ClickUp: status «to do»',
    enabled: true,
    position: 0,
    on: ['work_item.created'],
    when: { operator: 'AND', conditions: [{ field: 'source.list', operator: 'equals', value: list }] },
    target: { boardKey, phaseKey: null },
  });

  function stubClickUp(routes: unknown[]) {
    server.use(
      http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
        HttpResponse.json({
          config: {
            github: { enabled: false, sourceIds: null },
            gitlab: { enabled: false, sourceIds: null },
            // No List selection and no bindings: routes alone decide what ClickUp reads.
            clickup: { enabled: true, sourceIds: null },
          },
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({ enabled: false, configured: false, reauthRequired: false }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/factory-1/intake-routes`, () =>
        HttpResponse.json({ intakeRoutes: routes }),
      ),
    );
  }

  it('given a ClickUp List named only by a route to this board, then the board counts as fed', async () => {
    stubClickUp([clickupRoute(releaseBoard.id, 'list-1')]);

    const { result } = renderIntake('factory-1', releaseBoard);

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.fed).toBe(true);
    expect(result.current.unrouted).toBe(false);
  });

  it('given ClickUp on but no route naming a List, then the board is not fed by ClickUp', async () => {
    stubClickUp([]);

    const { result } = renderIntake('factory-1', releaseBoard);

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.fed).toBe(false);
  });
});

describe('useBoardIntake GitLab routing', () => {
  it('never queries GitHub issues for a GitLab-linked Work board', async () => {
    const sourceId = 'gitlab-project:encoded-source';
    let githubIssueRequests = 0;
    server.use(
      http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
        HttpResponse.json({
          config: {
            github: { enabled: false, sourceIds: [] },
            gitlab: { enabled: true, sourceIds: [sourceId] },
          },
        }),
      ),
      http.get(ROUTES_URL, () => HttpResponse.json({ intakeRoutes: [gitlabRoute('acme/app')] })),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({ enabled: true, configured: true, reauthRequired: false }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/issues`, () => HttpResponse.json({ issues: [], nextCursor: null })),
      http.get(`${TEST_BASE_URL}/web/github/projects/repo-1/issues`, () => {
        githubIssueRequests++;
        return HttpResponse.json({ issues: [], nextPage: null });
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
  });

  it('uses the GitLab MR feed for a GitLab-linked Work board and never requests GitHub PRs', async () => {
    stubIntake({});
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

    await waitFor(() =>
      expect(result.current.candidates).toContainEqual(
        expect.objectContaining({ source: 'gitlab-pr', sourceKey: 'gitlab-pr:encoded-5' }),
      ),
    );
    expect(githubRequests).toBe(0);
  });

  it("shows a routed GitLab project's issue on Work, without naming a board", async () => {
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
      http.get(ROUTES_URL, () => HttpResponse.json({ intakeRoutes: [gitlabRoute('acme/gl')] })),
      http.get(TEST_BASE_URL + '/web/gitlab/status', () =>
        HttpResponse.json({ enabled: true, configured: true, reauthRequired: false }),
      ),
      http.get(TEST_BASE_URL + '/web/gitlab/issues', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('factoryProjectId')).toBe('factory-1');
        expect(url.searchParams.has('board')).toBe(false);
        return HttpResponse.json({ issues: [issue], nextCursor: null });
      }),
    );

    const { result } = renderIntake('factory-1');

    await waitFor(() => expect(result.current.active).toBe('gitlab'));
    await waitFor(() => expect(result.current.candidates).toHaveLength(1));
    expect(result.current.candidates[0]).toMatchObject({
      source: 'gitlab-issue',
      sourceKey: issue.externalId,
      column: 'intake',
    });
  });
});

describe('useBoardIntake query loading', () => {
  describe('when intake configuration is still loading', () => {
    it('starts GitLab status before configuration resolves', async () => {
      stubIntake({});
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
        HttpResponse.json({ config: { github: { enabled: true, sourceIds: null } } }),
      ),
      // The project reads acme/app and acme/api: a GitHub route names each (acme/docs is only linked).
      http.get(`${TEST_BASE_URL}/web/factory/projects/:id/intake-routes`, () =>
        HttpResponse.json({
          intakeRoutes: ['acme/app', 'acme/api'].map((repository, position) => ({
            id: `route-${repository}`,
            name: `GitHub: ${repository}`,
            enabled: true,
            on: ['work_item.created'],
            when: {
              operator: 'AND',
              conditions: [
                { field: 'source.integration', operator: 'equals', value: 'github' },
                { field: 'source.repository', operator: 'equals', value: repository },
              ],
            },
            target: { boardKey: 'work', phaseKey: 'intake' },
            position,
            revision: 1,
            triggered: null,
            origin: null,
          })),
          canEdit: false,
        }),
      ),
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

  it('offers Work the issues of every repository its GitHub routes name, kept apart by repository', async () => {
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
