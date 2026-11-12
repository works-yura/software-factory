import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('Connections › GitHub', () => {
  it('lists App and token connections side by side, each with its account, kind, repositories and actions', async () => {
    githubHandlers({
      connections: [appConnection, tokenConnection, { ...tokenConnection, id: 'inst-env', tokenSource: 'env', accountLogin: 'works-yura', repositoryCount: null, status: 'needs_attention', error: 'Bad credentials' }],
    });
    renderService(<GitHubService />);

    const list = await screen.findByRole('list', { name: 'GitHub connections' });
    const app = within(list).getByRole('listitem', { name: '@eclipt' });
    expect(app).toHaveTextContent('App');
    expect(app).toHaveTextContent('Repositories: 12');
    expect(within(app).getByRole('button', { name: 'Manage on GitHub' })).toBeInTheDocument();
    expect(within(app).queryByRole('button', { name: 'Replace token' })).not.toBeInTheDocument();

    const token = within(list).getByRole('listitem', { name: '@client' });
    expect(token).toHaveTextContent('Token');
    expect(token).toHaveTextContent('Repositories: 3');
    expect(within(token).getByRole('button', { name: 'Replace token' })).toBeInTheDocument();
    expect(within(token).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();

    const legacy = within(list).getByRole('listitem', { name: '@works-yura' });
    expect(legacy).toHaveTextContent('Token (server env)');
    expect(legacy).toHaveTextContent('Needs attention');
    expect(legacy).toHaveTextContent('Bad credentials');
    expect(screen.getByRole('button', { name: 'Add another' })).toBeInTheDocument();
  });

  it('replaces a token in place and says why GitHub refused one', async () => {
    githubHandlers();
    const sent: unknown[] = [];
    server.use(
      http.put(`${TEST_BASE_URL}/web/github/token-connections/:id`, async ({ request, params }) => {
        sent.push({ id: params.id, body: await request.json() });
        if (sent.length === 1) return HttpResponse.json({ error: 'account_mismatch', message: 'This token belongs to @someone-else, not @client.' }, { status: 422 });
        return HttpResponse.json({ connection: tokenConnection, replaced: true });
      }),
    );
    renderService(<GitHubService />);

    const token = await screen.findByRole('listitem', { name: '@client' });
    await userEvent.click(within(token).getByRole('button', { name: 'Replace token' }));
    await userEvent.type(within(token).getByLabelText('GitHub access token'), 'ghp_new');
    await userEvent.click(within(token).getByRole('button', { name: 'Replace' }));

    const alert = await within(token).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't connect");
    expect(alert).toHaveTextContent('This token belongs to @someone-else, not @client.');
    // The refused token stays in the field to fix; this one replaces it.
    await userEvent.clear(within(token).getByLabelText('GitHub access token'));
    await userEvent.type(within(token).getByLabelText('GitHub access token'), 'ghp_right');
    await userEvent.click(within(token).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(within(token).queryByLabelText('GitHub access token')).not.toBeInTheDocument());
    expect(sent).toEqual([
      { id: 'inst-token', body: { token: 'ghp_new' } },
      { id: 'inst-token', body: { token: 'ghp_right' } },
    ]);
  });

  it('disconnects after a confirmation, and shows why when projects still use the connection', async () => {
    githubHandlers();
    const deleted: string[] = [];
    server.use(
      http.delete(`${TEST_BASE_URL}/web/github/connections/:id`, ({ params }) => {
        deleted.push(String(params.id));
        return HttpResponse.json(
          { error: 'connection_in_use', message: '2 project connections still use repositories of @client.', projectConnections: 2 },
          { status: 409 },
        );
      }),
    );
    renderService(<GitHubService />);

    const token = await screen.findByRole('listitem', { name: '@client' });
    await userEvent.click(within(token).getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect @client?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    const alert = await within(token).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't disconnect");
    expect(alert).toHaveTextContent('2 project connections still use repositories of @client.');
    expect(deleted).toEqual(['inst-token']);
  });

  it('adds another connection with a token; the App way is offered only when the server has the App', async () => {
    githubHandlers({ appConfigured: false });
    server.use(
      http.post(`${TEST_BASE_URL}/web/github/token-connections`, () =>
        HttpResponse.json({ connection: { ...tokenConnection, id: 'inst-new', accountLogin: 'another', repositoryCount: 5 }, replaced: false }),
      ),
    );
    renderService(<GitHubService />);

    await userEvent.click(await screen.findByRole('button', { name: 'Add another' }));
    expect(screen.queryByRole('button', { name: 'Through the GitHub App' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('GitHub access token'), 'ghp_another');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Connected @another')).toBeInTheDocument();
    expect(screen.getByText('Repositories it can reach: 5.')).toBeInTheDocument();
  });

  it('offers both ways to an admin of an organization with no GitHub yet', async () => {
    githubHandlers({ connections: [] });
    renderService(<GitHubService />);

    expect(await screen.findByText(/GitHub is not connected yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Through the GitHub App' })).toBeInTheDocument();
    expect(screen.getByLabelText('GitHub access token')).toHaveAttribute('type', 'password');
  });

  it('shows a member the connections without the actions', async () => {
    githubHandlers({ canManage: false });
    renderService(<GitHubService />);

    const token = await screen.findByRole('listitem', { name: '@client' });
    expect(within(token).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add another' })).not.toBeInTheDocument();
    expect(screen.getByText('Only organization admins can connect, replace or disconnect GitHub.')).toBeInTheDocument();
  });
});
