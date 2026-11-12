import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { IntakeSection } from '../IntakeSection';

const FACTORY_ID = 'fp-1';

function renderIntake() {
  renderWithProviders(
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/settings/intake`]}>
      <Routes>
        <Route path="/factories/:factoryId/settings/intake" element={<IntakeSection />} />
      </Routes>
    </MemoryRouter>,
  );
}

function useHandlers(clickup: { connected: boolean }) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'Acme Web', repositories: [] }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/clickup/status`, () =>
      HttpResponse.json({ configured: true, connected: clickup.connected, workspaces: ['Acme'], intervalSeconds: 60 }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/boards`, () => HttpResponse.json({ boards: [] })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/intake-routes`, () => HttpResponse.json({ intakeRoutes: [], canEdit: true })),
  );
}

describe('IntakeSection', () => {
  it('keeps only the routes, with one line about ClickUp that links to Connections', async () => {
    useHandlers({ connected: true });
    renderIntake();

    expect(await screen.findByText(/ClickUp is connected\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set it up in Connections' })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/settings/integrations?connection=clickup`,
    );
    expect(screen.queryByRole('switch', { name: 'Import ClickUp tasks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sources' })).not.toBeInTheDocument();
  });

  it('says when ClickUp is not connected', async () => {
    useHandlers({ connected: false });
    renderIntake();

    expect(await screen.findByText(/ClickUp is not connected\./)).toBeInTheDocument();
  });
});
