import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { listedRepository } from '../../../../../../e2e/ui/factory-projects';
import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { IntakeSection } from '../IntakeSection';

const FACTORY_ID = 'fp-1';

const alertRoute = {
  id: 'r-dependabot',
  name: 'Dependabot',
  enabled: true,
  position: 0,
  when: {
    operator: 'AND',
    conditions: [
      { field: 'source.integration', operator: 'equals', value: 'github' },
      { field: 'source.kind', operator: 'equals', value: 'dependabot_alert' },
    ],
  },
  target: { boardKey: 'work', phaseKey: null, joinClosedIssue: false },
  on: ['work_item.created'],
  revision: 1,
  problems: [],
  triggered: null,
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-14T00:00:00.000Z',
  createdBy: 'u1',
  updatedBy: 'u1',
  origin: null,
};

function renderIntake() {
  renderWithProviders(
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/settings/intake`]}>
      <Routes>
        <Route path="/factories/:factoryId/settings/intake" element={<IntakeSection />} />
      </Routes>
    </MemoryRouter>,
  );
}

function useHandlers(options: { enabled: boolean; routes?: unknown[]; github?: boolean }) {
  let config = {
    github: { enabled: true, sourceIds: null },
    gitlab: { enabled: false, sourceIds: null },
    clickup: { enabled: false, sourceIds: null },
    dependabot: { enabled: options.enabled, sourceIds: null },
  };
  const saved: unknown[] = [];
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({
        projects: [
          {
            id: FACTORY_ID,
            name: 'Acme Web',
            repositories: options.github === false ? [] : [listedRepository('ghp-1', 'acme/app')],
          },
        ],
      }),
    ),
    http.get(`${TEST_BASE_URL}/web/clickup/status`, () =>
      HttpResponse.json({ configured: true, connected: false, workspaces: [], intervalSeconds: 60 }),
    ),
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/boards`, () => HttpResponse.json({ boards: [] })),
    http.get(`${TEST_BASE_URL}/web/factory/projects/:id/intake-routes`, () =>
      HttpResponse.json({ intakeRoutes: options.routes ?? [], canEdit: true }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () => HttpResponse.json({ config })),
    http.put(`${TEST_BASE_URL}/web/intake/config`, async ({ request }) => {
      const body = (await request.json()) as typeof config;
      saved.push(body);
      config = body;
      return HttpResponse.json({ config });
    }),
    http.get(`${TEST_BASE_URL}/web/github/dependabot/status`, () =>
      HttpResponse.json({
        repositories: [
          { repository: 'acme/app', checkedAt: '2026-11-14T00:00:00.000Z', openAlerts: 2 },
          { repository: 'acme/api', checkedAt: '2026-11-14T00:00:00.000Z', problem: 'permission', message: 'no' },
        ],
      }),
    ),
  );
  return { saved };
}

describe('Dependabot intake in Settings', () => {
  it('is off until switched on, and switching it on saves the org\'s intake config', async () => {
    const { saved } = useHandlers({ enabled: false, routes: [alertRoute] });
    renderIntake();

    const toggle = await screen.findByRole('switch', { name: 'Take Dependabot alerts' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ github: { enabled: true }, dependabot: { enabled: true, sourceIds: null } });
    expect(await screen.findByText('acme/app: 2 open alerts')).toBeInTheDocument();
  });

  it('says which repository lacks the permission, and that no route takes alerts yet', async () => {
    useHandlers({ enabled: true });
    renderIntake();

    expect(
      await screen.findByText('acme/api: the GitHub connection lacks the "Dependabot alerts: read" permission.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No route takes Dependabot alerts yet, so none are filed.')).toBeInTheDocument();
  });

  it('is not offered to a Factory without a GitHub repository', async () => {
    useHandlers({ enabled: false, github: false });
    renderIntake();

    expect(await screen.findByText(/ClickUp is not connected\./)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Take Dependabot alerts' })).not.toBeInTheDocument();
  });
});
