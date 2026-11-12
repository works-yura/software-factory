import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { GitLabService } from '../SourceControlServices';

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

describe('Connections › GitLab', () => {
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

const appConnection = { id: 'inst-app', kind: 'app', installationId: 77, accountLogin: 'eclipt', accountType: 'Organization', repositoryCount: 12, status: 'ok' };
const tokenConnection = { id: 'inst-token', kind: 'token', tokenSource: 'stored', installationId: 4242, accountLogin: 'client', accountType: 'User', repositoryCount: 3, status: 'ok' };

function githubHandlers(options: { canManage?: boolean; appConfigured?: boolean; connections?: unknown[] } = {}) {
  const connections = options.connections ?? [appConnection, tokenConnection];
  const canManage = options.canManage ?? true;
  const appConfigured = options.appConfigured ?? true;
  server.use(
    signedIn(),
    http.get(`${TEST_BASE_URL}/web/github/status`, () =>
      HttpResponse.json({ enabled: true, appConfigured, canManage, connected: connections.length > 0, installations: [], reason: connections.length ? 'ready' : 'not_connected' }),
    ),
    http.get(`${TEST_BASE_URL}/web/github/connections`, () => HttpResponse.json({ appConfigured, canManage, connections })),
    http.get(`${TEST_BASE_URL}/web/github/pat`, () => HttpResponse.json({ configured: false, reviewerConfigured: false })),
  );
}
