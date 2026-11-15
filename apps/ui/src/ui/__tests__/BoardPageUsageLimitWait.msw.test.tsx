// A card whose run is out of model usage waits for the reset instead of reading as failed.
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { resumeTime } from '../domains/factory/boardCardState';
import { listedRepository } from '../../../e2e/ui/factory-projects';
import { server } from '../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import type { FactoryDecisionSummary } from '../domains/factory/services/decisions';
import { createAppRoutes } from '../router';

const FACTORY_ID = 'fp-1';
const REPO_ID = 'repo-1';

const LONG_ITEM_TITLE = 'Login fails with a 500';
const LONG_CANDIDATE_TITLE = 'Crash on logout';
const LIMIT_ERROR = 'Factory skill run ended in error: Every Claude account this run may use is out of usage.';

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
  title: LONG_ITEM_TITLE,
  stages: ['triage'],
  stageHistory: [],
  sessions: {},
  metadata: { number: 7 },
  revision: 1,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

const issueCandidate = {
  number: 9,
  title: LONG_CANDIDATE_TITLE,
  url: 'https://github.com/acme/app/issues/9',
  author: 'octocat',
  labels: [],
  comments: 0,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

const resumesAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

const waitingDecision: FactoryDecisionSummary = {
  id: 'decision-1',
  evaluationId: 'evaluation-1',
  workItemId: issueWorkItem.id,
  type: 'invokeSkill',
  role: null,
  status: 'retry',
  attempts: 0,
  failureOccurrence: 0,
  source: null,
  failureCode: 'run_usage_limited',
  canRetry: false,
  lastError: LIMIT_ERROR,
  waitingUntil: resumesAt,
  waitingReason: 'usage_limit',
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:01:00.000Z',
  completedAt: null,
};

/** Stubs the board's data endpoints with one work item and one candidate. */
function stubBoardEndpoints(decisions: FactoryDecisionSummary[] = []) {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1', permissions: ['board.read', 'self.write', 'card.write', 'comment.write', 'run.start', 'session.write', 'factory.configure'] } }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: FACTORY_ID,
            name: 'Acme Factory',
            repositories: [listedRepository(REPO_ID, 'acme/app', { branch: 'main', sandboxWorkdir: '/repo' })],
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items`, () =>
      HttpResponse.json({ workItems: [issueWorkItem] }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/decisions`, () => HttpResponse.json({ decisions })),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({
        config: {
          github: { enabled: true, sourceIds: ['acme/app'] },
        },
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/projects/${REPO_ID}/issues`, ({ request }) =>
      HttpResponse.json({
        issues: new URL(request.url).searchParams.has('label') ? [] : [issueCandidate],
        nextPage: null,
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/sessions`, () => HttpResponse.json({ sessions: [] })),
  );
}

function renderWorkBoard() {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [`/factories/${FACTORY_ID}/work`] });
  return renderWithProviders(<RouterProvider router={router} />);
}

describe('Board card waiting for a usage reset', () => {
  it('says when the run resumes instead of showing an error', async () => {
    stubBoardEndpoints([waitingDecision]);
    renderWorkBoard();

    expect(
      await screen.findByText(`Waiting for usage reset · resumes at ${resumeTime(resumesAt)}`),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/could not start/)).not.toBeInTheDocument();
  });
});
