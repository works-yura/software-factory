import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { GitHubService, GitLabService } from '../SourceControlServices';

const FACTORY_ID = 'fp-1';

function renderService(element: ReactElement) {
  renderWithProviders(
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/settings/integrations?tab=services`]}>
      <Routes>
        <Route path="/factories/:factoryId/settings/integrations" element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

const signedIn = () =>
  http.get(`${TEST_BASE_URL}/auth/me`, () => HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }));

describe('Integrations › GitLab', () => {
  it('offers reconnection when the Platform GitLab account needs reauthorization', async () => {
    server.use(
      signedIn(),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({
          enabled: true,
          configured: false,
          mode: 'platform',
          connections: [{ id: 'conn-1', integrationId: 'gitlab', status: 'needs_reauth', accountLabel: 'fixture' }],
          accounts: [],
          reauthRequired: true,
          reason: 'not_connected',
        }),
      ),
    );
    renderService(<GitLabService />);

    const reconnect = await screen.findByRole('button', { name: 'Reconnect GitLab' });
    expect(reconnect.tagName).toBe('BUTTON');
  });

  it('connects another account and links to managing a connected GitLab, and back to Repositories', async () => {
    server.use(
      signedIn(),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({ enabled: true, configured: true, mode: 'platform', accounts: ['gitlab.com'], reauthRequired: false, reason: 'ready' }),
      ),
    );
    renderService(<GitLabService />);

    expect(await screen.findByRole('button', { name: 'Connect another GitLab account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage GitLab connection' })).toHaveAttribute('href', 'https://projects.mastra.ai');
    expect(screen.getByRole('link', { name: 'Open Repositories' })).toHaveAttribute('href', `/factories/${FACTORY_ID}/settings/repositories`);
  });
});

describe('Integrations › GitHub', () => {
  it('names a deployment access token and offers no Manage step', async () => {
    server.use(
      signedIn(),
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({
          enabled: true,
          mode: 'token',
          connected: true,
          installations: [{ installationId: 4242, accountLogin: 'yura', accountType: 'User' }],
          reason: 'ready',
        }),
      ),
    );
    renderService(<GitHubService />);

    expect(await screen.findByText("GitHub managed by the deployment's access token (GITHUB_ACCESS_TOKEN)")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage GitHub connection' })).not.toBeInTheDocument();
  });

  it('says GitHub is not connected yet when the App is not installed', async () => {
    server.use(
      signedIn(),
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, connected: false, installations: [], reason: 'not_connected' }),
      ),
    );
    renderService(<GitHubService />);

    expect(await screen.findByText(/GitHub is not connected yet/)).toBeInTheDocument();
  });
});
