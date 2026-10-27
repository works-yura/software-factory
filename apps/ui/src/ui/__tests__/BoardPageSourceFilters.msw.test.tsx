import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { openPropertySubmenu } from '../../../e2e/ui/properties-menu';
import { renderWithProviders, TEST_BASE_URL, waitForMutationsIdle } from '../../../e2e/ui/render';
import { createAppRoutes } from '../router';
import { githubIssue, wireSourceCards } from './fixtures/boardSourceFilters';
import { FACTORY_ID, stubWorkBoard } from './workBoardStubs';

function stubSources() {
  stubWorkBoard();
  server.use(
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({
        config: {
          github: { enabled: true, sourceIds: ['acme/app'] },
        },
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/status`, () =>
      HttpResponse.json({ enabled: true, connected: true, installations: [] }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/projects/repo-1/issues`, ({ request }) =>
      HttpResponse.json({
        issues: new URL(request.url).searchParams.has('label') ? [] : [githubIssue],
        nextPage: null,
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items`, () =>
      HttpResponse.json({ workItems: wireSourceCards }),
    ),
  );
}

function renderBoard(search = '') {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [`/factories/${FACTORY_ID}/work${search}`] });
  return { router, ...renderWithProviders(<RouterProvider router={router} />) };
}

async function intakeSourceOptions() {
  await openPropertySubmenu(userEvent.setup(), 'Board properties', 'Intake source');
  return screen.getAllByRole('menuitemcheckbox').map(option => option.textContent);
}

describe('Board source filters', () => {
  it('offers connected providers and Manual, but not unconnected sources', async () => {
    stubSources();
    const view = renderBoard();
    await waitForMutationsIdle(view.client);
    expect(await intakeSourceOptions()).toEqual(['GitHub', 'Manual']);
  });

  it('keeps a saved filter on a disconnected source labelled and selectable', async () => {
    stubSources();
    const view = renderBoard('?source=gitlab');
    await waitForMutationsIdle(view.client);
    expect(await intakeSourceOptions()).toEqual(['GitHub', 'GitLab', 'Manual']);
    expect(screen.getByRole('menuitemcheckbox', { name: 'GitLab' })).toHaveAttribute('aria-checked', 'true');
  });

  it('offers only Manual when configured providers are disconnected', async () => {
    stubSources();
    server.use(
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, connected: false, installations: [] }),
      ),
    );
    const view = renderBoard();
    await waitForMutationsIdle(view.client);
    expect(await intakeSourceOptions()).toEqual(['Manual']);
  });
  it('explains that filters excluded Intake candidates instead of suggesting an integration setup', async () => {
    stubSources();
    server.use(
      http.get(`${TEST_BASE_URL}/web/factory/projects/${FACTORY_ID}/work-items`, () =>
        HttpResponse.json({ workItems: [] }),
      ),
    );
    const view = renderBoard('?source=gitlab');
    await waitForMutationsIdle(view.client);
    await within(screen.getByTestId('board-column-intake')).findByText('No work items match filters');
    expect(
      within(screen.getByTestId('board-column-intake')).getByText(/Try adjusting or clearing your filters\./),
    ).toBeInTheDocument();
    expect(screen.queryByText('No intake sources')).not.toBeInTheDocument();
  });
});
