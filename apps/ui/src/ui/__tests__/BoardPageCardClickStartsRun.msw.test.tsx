/**
 * A card's button is a move: it transitions the card into the lane whose rule
 * runs the work, and the lane's own button re-enters it. Nothing here starts a
 * run directly — the server's rules do, off the transition.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { listedRepository } from '../../../e2e/ui/factory-projects';
import { server } from '../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL, waitForMutationsIdle } from '../../../e2e/ui/render';
import { createAppRoutes } from '../router';

const FACTORY_ID = 'fp-1';
const REPO_ID = 'repo-1';

// Wire shape as served by /web/factory/*/work-items: the client derives
// `source`/`url` from `externalSource` (see fromWireWorkItem).
const issueWorkItem = {
  id: 'item-1',
  orgId: 'org-1',
  createdBy: 'user-1',
  factoryProjectId: FACTORY_ID,
  externalSource: {
    integrationId: 'github',
    type: 'issue',
    externalId: 'github-issue:7',
    url: 'https://github.com/acme/app/issues/7',
  },
  parentWorkItemId: null,
  title: 'Fix login bug',
  stages: ['triage'],
  stageHistory: [],
  sessions: {},
  metadata: { number: 7 },
  revision: 1,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

const logoutIssue = {
  number: 9,
  title: 'Crash on logout',
  url: 'https://github.com/acme/app/issues/9',
  author: 'octocat',
  labels: [],
  comments: 0,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

const intakeWorkItem = { ...issueWorkItem, stages: ['intake'] };

const gitlabWorkItem = {
  ...issueWorkItem,
  id: 'gitlab-item-1',
  externalSource: {
    integrationId: 'gitlab',
    type: 'issue',
    externalId: 'gitlab-issue:encoded-issue-1',
    url: 'https://gitlab.com/acme/app/-/work_items/1',
  },
  title: 'GitLab issue added to board',
  stages: ['intake'],
  metadata: {
    gitlabIssueId: '1',
    identifier: 'acme/app#1',
    sourceId: 'gitlab-source-1',
  },
};

const gitlabCandidateIssue = {
  id: '2',
  externalId: 'gitlab-issue:encoded-issue-2',
  identifier: 'acme/app#2',
  title: 'GitLab candidate issue',
  url: 'https://gitlab.com/acme/app/-/work_items/2',
  state: 'opened',
  stateType: 'unstarted',
  priority: null,
  assignee: null,
  author: 'grace',
  source: 'acme/app',
  sourceId: 'gitlab-source-1',
  labels: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

interface TransitionRequest {
  itemId: string;
  body: Record<string, unknown>;
}

/** Stubs the board's data endpoints and captures everything a card click writes. */
function stubBoardEndpoints({
  issues = [] as object[],
  workItems = [issueWorkItem] as object[],
  multiRepository = false,
} = {}) {
  const transitions: TransitionRequest[] = [];
  const patches: Array<{ itemId: string; body: Record<string, unknown> }> = [];
  const created: Array<Record<string, unknown>> = [];
  const comments: Array<{ itemId: string; body: Record<string, unknown> }> = [];

  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: FACTORY_ID,
            name: 'Acme Factory',
            repositories: [
              listedRepository(REPO_ID, 'acme/app', { branch: 'main', sandboxWorkdir: '/repo' }),
              ...(multiRepository ? [listedRepository('repo-2', 'acme/other', { branch: 'main' })] : []),
            ],
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items`, () => HttpResponse.json({ workItems })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/decisions`, () =>
      HttpResponse.json({ decisions: [] }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({
        config: {
          github: { enabled: true, sourceIds: ['acme/app'] },
        },
      }),
    ),
    http.get(`${TEST_BASE_URL}/api/agent-controller/code/sessions/:resourceId/permissions`, () =>
      HttpResponse.json({ categories: {}, tools: {} }),
    ),
    // The label-filtered (status: auto-triaged) feed stays empty; the plain feed
    // serves the candidate under test.
    http.get(`${TEST_BASE_URL}/web/github/projects/${REPO_ID}/issues`, ({ request }) => {
      const label = new URL(request.url).searchParams.get('label');
      if (label && label !== 'status: auto-triaged') {
        return HttpResponse.error();
      }

      return HttpResponse.json({ issues: label ? [] : issues, nextPage: null });
    }),
    http.get(`${TEST_BASE_URL}/web/github/projects/${REPO_ID}/issues/:number`, ({ params }) =>
      HttpResponse.json({
        number: Number(params.number),
        title: 'Crash on logout',
        url: `https://github.com/acme/app/issues/${String(params.number)}`,
        author: 'octocat',
        labels: [],
        comments: 0,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
        description: 'The app crashes when logging out.',
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/projects/${REPO_ID}/prs/:number`, () =>
      HttpResponse.json({ error: 'pull_request_not_found' }, { status: 404 }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/sessions`, () => HttpResponse.json({ sessions: [] })),
    http.post(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      created.push(body);
      return HttpResponse.json({
        workItem: { ...issueWorkItem, id: 'item-filed', title: String(body.title), stages: ['intake'] },
      });
    }),
    http.post(`${TEST_BASE_URL}/web/factory/work-items/:itemId/comments`, async ({ params, request }) => {
      comments.push({ itemId: String(params.itemId), body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({ comment: { id: 'comment-1' } });
    }),
    http.patch(`${TEST_BASE_URL}/web/factory/work-items/:itemId`, async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push({ itemId: String(params.itemId), body });
      return HttpResponse.json({
        workItem: {
          ...issueWorkItem,
          id: String(params.itemId),
          revision: 5,
          ...(body.metadata ? { metadata: body.metadata } : {}),
        },
      });
    }),
    http.post(
      `${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items/:itemId/transition`,
      async ({ params, request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        transitions.push({ itemId: String(params.itemId), body });
        return HttpResponse.json({
          result: {
            status: 'accepted',
            transitionId: `transition-${transitions.length}`,
            itemId: String(params.itemId),
            revision: 9,
            stage: body.stage,
            decisions: [],
          },
        });
      },
    ),
  );

  return { transitions, patches, created, comments };
}

function renderWorkBoard() {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [`/factories/${FACTORY_ID}/work`] });
  return renderWithProviders(<RouterProvider router={router} />);
}

async function moveFromCardDetails(cardTitle: string, action: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Details for ${cardTitle}` }));

  const dialog = await screen.findByRole('dialog', { name: cardTitle });
  await user.click(within(dialog).getByRole('button', { name: action }));
}

describe('Board card buttons move the card', () => {
  it('issues a transition to Triage with cause card_action when Investigate is clicked', async () => {
    const { transitions } = stubBoardEndpoints({ workItems: [intakeWorkItem] });
    renderWorkBoard();

    await moveFromCardDetails('Fix login bug', 'Investigate');

    await waitFor(() => expect(transitions).toHaveLength(1));
    expect(transitions[0]).toMatchObject({
      itemId: 'item-1',
      body: { board: 'work', stage: 'triage', cause: 'card_action', expectedRevision: 1 },
    });
    expect(transitions[0]?.body).not.toHaveProperty('reenter');
  });

  it('investigates an unattributed item in a multi-repository factory without choosing a repository', async () => {
    const { patches, transitions } = stubBoardEndpoints({
      multiRepository: true,
      workItems: [{ ...issueWorkItem, stages: ['intake'] }],
    });
    renderWorkBoard();

    await moveFromCardDetails('Fix login bug', 'Investigate');

    // The card runs across the environment: no dialog, no repository written.
    await waitFor(() => expect(transitions).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: 'Choose a repository' })).not.toBeInTheDocument();
    expect(patches).toHaveLength(0);
    expect(transitions[0]).toMatchObject({
      itemId: 'item-1',
      body: { stage: 'triage', cause: 'card_action' },
    });
  });

  it('shows each repository change request a card spanning the environment still has out', async () => {
    stubBoardEndpoints({
      multiRepository: true,
      workItems: [
        {
          ...issueWorkItem,
          stages: ['review'],
          metadata: {
            number: 7,
            openChangeRequests: [
              { repository: 'works_yura/ai', number: 4, provider: 'gitlab' },
              { repository: 'works_yura/test', number: 2, provider: 'gitlab' },
            ],
            openPullRequestNumber: 2,
          },
        },
      ],
    });
    renderWorkBoard();

    const list = await screen.findByLabelText('Open change requests');
    expect(within(list).getByText('ai !4')).toHaveAttribute('title', 'works_yura/ai !4 is still open');
    expect(within(list).getByText('test !2')).toBeVisible();
  });

  it("re-enters the lane when the card's own lane button is clicked", async () => {
    const { transitions } = stubBoardEndpoints();
    renderWorkBoard();

    await moveFromCardDetails('Fix login bug', 'Investigate');

    await waitFor(() => expect(transitions).toHaveLength(1));
    expect(transitions[0]?.body).toMatchObject({ stage: 'triage', cause: 'card_action', reenter: true });
  });

  it('offers only explicit card moves without hands-off approval shortcuts', async () => {
    stubBoardEndpoints();
    renderWorkBoard();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Actions for Fix login bug' }));

    expect(await screen.findByRole('menuitem', { name: 'Investigate' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Plan' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /hands-off/i })).not.toBeInTheDocument();
  });

  it('files a candidate in Intake, posts its custom prompt as a comment, then moves it', async () => {
    const { transitions, created, comments } = stubBoardEndpoints({
      issues: [logoutIssue],
    });
    const { client } = renderWorkBoard();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Details for Crash on logout' }));
    const dialog = await screen.findByRole('dialog', { name: 'Crash on logout' });
    expect(await within(dialog).findByText('The app crashes when logging out.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Custom prompt…' }));
    await user.type(await screen.findByRole('textbox', { name: 'Prompt for Crash on logout' }), 'Check the token TTL');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(transitions).toHaveLength(1));
    await waitForMutationsIdle(client);
    expect(created).toEqual([expect.objectContaining({ title: 'Crash on logout', stages: ['intake'] })]);
    expect(comments).toEqual([
      { itemId: 'item-filed', body: expect.objectContaining({ body: 'Guidance for this run: Check the token TTL' }) },
    ]);
    expect(transitions[0]).toMatchObject({ itemId: 'item-filed', body: { stage: 'triage', cause: 'card_action' } });
  });

  it('reports the guidance that could not be posted, and leaves the card in Intake', async () => {
    const { transitions } = stubBoardEndpoints({ issues: [logoutIssue] });
    server.use(
      http.post(`${TEST_BASE_URL}/web/factory/work-items/:itemId/comments`, () =>
        HttpResponse.json({ error: 'The guidance could not be posted.' }, { status: 500 }),
      ),
    );
    renderWorkBoard();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Details for Crash on logout' }));
    const dialog = await screen.findByRole('dialog', { name: 'Crash on logout' });
    await user.click(within(dialog).getByRole('button', { name: 'Custom prompt…' }));
    await user.type(await screen.findByRole('textbox', { name: 'Prompt for Crash on logout' }), 'Check the token TTL');
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText('The guidance could not be posted.')).toBeInTheDocument();
    expect(transitions).toEqual([]);
  });

  it('offers no hands-off twin for Prepare approval, whose outcome is a maintainer decision', async () => {
    stubBoardEndpoints({
      workItems: [
        { ...issueWorkItem, metadata: { number: 7, labels: ['status: needs approval'] }, stages: ['triage'] },
      ],
    });
    renderWorkBoard();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Actions for Fix login bug' }));
    await screen.findByRole('menuitem', { name: 'Prepare approval' });
    expect(screen.queryByRole('menuitem', { name: 'Prepare approval hands-off' })).not.toBeInTheDocument();
  });

  it('offers the ordinary runs once a person moved a labelled card into a working lane, before the label catches up', async () => {
    stubBoardEndpoints({
      workItems: [
        {
          ...issueWorkItem,
          metadata: { number: 7, labels: ['status: needs approval'] },
          stages: ['planning'],
        },
      ],
    });
    renderWorkBoard();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Actions for Fix login bug' }));
    await screen.findByRole('menuitem', { name: 'Build' });
    expect(screen.queryByRole('menuitem', { name: 'Prepare approval' })).not.toBeInTheDocument();
  });

  it('shows GitLab descriptions before and after an issue is added to the board', async () => {
    stubBoardEndpoints({ workItems: [gitlabWorkItem] });
    server.use(
      http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
        HttpResponse.json({
          config: {
            github: { enabled: false, sourceIds: null },
            gitlab: { enabled: true, sourceIds: ['gitlab-source-1'] },
          },
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({ enabled: true, configured: true, reauthRequired: false }),
      ),
      // A GitLab project linked to the Factory and named by one of its routes: Work browses its issues.
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({
          projects: [
            {
              id: FACTORY_ID,
              name: 'Acme Factory',
              repositories: [
                listedRepository(REPO_ID, 'acme/app', { branch: 'main', sandboxWorkdir: '/repo' }),
                listedRepository('repo-gl', 'acme/gl', { integrationId: 'gitlab' }),
              ],
            },
          ],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/intake-routes`, () =>
        HttpResponse.json({
          intakeRoutes: [
            {
              id: 'route-gl',
              name: 'GitLab: acme/gl',
              enabled: true,
              position: 0,
              on: ['work_item.created'],
              when: {
                operator: 'AND',
                conditions: [
                  { field: 'source.integration', operator: 'equals', value: 'gitlab' },
                  { field: 'source.repository', operator: 'equals', value: 'acme/gl' },
                ],
              },
              target: { boardKey: 'work', phaseKey: null },
            },
          ],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/issues`, () =>
        HttpResponse.json({ issues: [gitlabCandidateIssue], nextCursor: null }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/issues/:issueId`, ({ params, request }) => {
        expect(new URL(request.url).searchParams.get('factoryProjectId')).toBe(FACTORY_ID);
        const description =
          params.issueId === 'gitlab-issue:encoded-issue-1'
            ? 'Persisted GitLab description.'
            : 'Candidate GitLab description.';
        return HttpResponse.json({ description, comments: [] });
      }),
    );

    renderWorkBoard();
    const user = userEvent.setup();

    const persisted = await screen.findByRole('button', { name: 'Details for GitLab issue added to board' });
    await screen.findByRole('button', { name: 'Details for GitLab candidate issue' });
    await user.click(persisted);

    const persistedDialog = await screen.findByRole('dialog', { name: 'GitLab issue added to board' });
    expect(await within(persistedDialog).findByText('Persisted GitLab description.')).toBeInTheDocument();
    await user.click(within(persistedDialog).getByRole('button', { name: 'Collapse GitLab issue added to board' }));

    await user.click(await screen.findByRole('button', { name: 'Details for GitLab candidate issue' }));
    const candidateDialog = await screen.findByRole('dialog', { name: 'GitLab candidate issue' });
    expect(await within(candidateDialog).findByText('Candidate GitLab description.')).toBeInTheDocument();
  });

  it('links the card source from the panel header', async () => {
    stubBoardEndpoints();
    renderWorkBoard();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Details for Fix login bug' }));

    const dialog = await screen.findByRole('dialog', { name: 'Fix login bug' });
    expect(within(dialog).getByRole('link', { name: 'Open in GitHub: #7' })).toHaveAttribute(
      'href',
      'https://github.com/acme/app/issues/7',
    );
  });
});
