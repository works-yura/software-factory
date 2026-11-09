import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { listedRepository } from '../../../../../../e2e/ui/factory-projects';
import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { RepositoriesSection } from '../RepositoriesSection';

const FACTORY_ID = 'fp-1';
const PRIMARY_PROJECT = 'rhys-group1/factory-validation-rhys-20260916/factory-gitlab-primary';

function renderRepositoriesSettings() {
  renderWithProviders(
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/settings/repositories`]}>
      <Routes>
        <Route path="/factories/:factoryId/settings/repositories" element={<RepositoriesSection />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Repositories settings', () => {
  it('offers reconnection when the Platform GitLab account needs reauthorization', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'factory-gitlab-primary', repositories: [] }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: false, connected: false, installations: [], reason: 'missing_config' }),
      ),
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

    renderRepositoriesSettings();

    const reconnect = await screen.findByRole('button', { name: 'Reconnect GitLab' });
    expect(reconnect).toBeInTheDocument();
    expect(reconnect.tagName).toBe('BUTTON');
  });

  it('shows GitLab repository details without unrelated GitHub settings for a GitLab-only Factory', async () => {
    let gitlabProjectReads = 0;
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({
          projects: [
            {
              id: FACTORY_ID,
              name: 'factory-gitlab-primary',
              repositories: [
                listedRepository('repo-1', PRIMARY_PROJECT, {
                  connectionId: 'conn-1',
                  integrationId: 'gitlab',
                  branch: 'main',
                  sandboxWorkdir: '~/factory-gitlab-primary',
                }),
              ],
            },
          ],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({
          enabled: false,
          connected: false,
          installations: [],
          reason: 'missing_config',
          diagnostics: { missingGithubAppEnvVars: ['GITHUB_APP_ID'] },
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({
          enabled: true,
          configured: true,
          mode: 'platform',
          accounts: ['gitlab.com'],
          reauthRequired: false,
          reason: 'ready',
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/projects`, () => {
        gitlabProjectReads += 1;
        return HttpResponse.json({
          projects: [
            {
              id: 'gitlab-project:control',
              name: 'rhys-group1/factory-validation-rhys-20260916/factory-gitlab-control',
              projectId: '20',
              projectPath: 'rhys-group1/factory-validation-rhys-20260916/factory-gitlab-control',
              installationStorageId: 'inst-1',
              accountLabel: 'gitlab.com',
              defaultBranch: 'main',
              sandboxProvider: 'custom',
              sandboxWorkdir: '~/factory-gitlab-control',
            },
          ],
        });
      }),
    );

    renderRepositoriesSettings();

    expect((await screen.findAllByText(PRIMARY_PROJECT)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Default branch: main')).length).toBeGreaterThan(0);
    await waitFor(() => expect(gitlabProjectReads).toBe(1));
    expect(await screen.findByText(/factory-gitlab-control/)).toBeInTheDocument();
    expect(screen.queryByText('GitHub is disabled on the server.')).not.toBeInTheDocument();
    expect(screen.queryByText('GitHub CLI tokens')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sandbox' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Setup command for/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Environment' })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/settings/environment`,
    );
    const connectAnother = screen.getByRole('button', { name: 'Connect another GitLab account' });
    expect(connectAnother).toBeInTheDocument();
    expect(connectAnother.tagName).toBe('BUTTON');
    const manage = screen.getByRole('link', { name: 'Manage GitLab connection' });
    expect(manage).toHaveAttribute('href', 'https://projects.mastra.ai');
    expect(screen.queryByText('Worker token')).not.toBeInTheDocument();
  });

  it('offers to connect GitHub when the server has GitHub but GitLab repositories are already linked', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({
          projects: [
            {
              id: FACTORY_ID,
              name: 'factory-gitlab-primary',
              repositories: [
                listedRepository('repo-1', PRIMARY_PROJECT, {
                  connectionId: 'conn-1',
                  integrationId: 'gitlab',
                  branch: 'main',
                  sandboxWorkdir: '~/factory-gitlab-primary',
                }),
              ],
            },
          ],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({ enabled: true, connected: false, installations: [], reason: 'not_connected' }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({ enabled: true, configured: true, mode: 'direct', accounts: ['gitlab.com'], reason: 'ready' }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/projects`, () => HttpResponse.json({ projects: [] })),
    );

    renderRepositoriesSettings();

    expect((await screen.findAllByText(PRIMARY_PROJECT)).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument();
  });

  it('lists GitHub repositories of an access token with no Connect or Manage step, beside GitLab', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1' } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'factory-gitlab-primary', repositories: [] }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/github/status`, () =>
        HttpResponse.json({
          enabled: true,
          mode: 'token',
          connected: true,
          installations: [{ installationId: 4242, accountLogin: 'yura', accountType: 'User' }],
          reason: 'ready',
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/github/repos`, () =>
        HttpResponse.json({
          repos: [
            {
              id: 99,
              fullName: 'yura/app',
              name: 'app',
              owner: 'yura',
              defaultBranch: 'main',
              private: true,
              installationId: 4242,
              installationStorageId: 'inst-gh',
              sandboxProvider: 'custom',
              sandboxWorkdir: '~/app',
            },
          ],
        }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/status`, () =>
        HttpResponse.json({ enabled: true, configured: true, mode: 'direct', accounts: ['gitlab.com'], reason: 'ready' }),
      ),
      http.get(`${TEST_BASE_URL}/web/gitlab/projects`, () => HttpResponse.json({ projects: [] })),
    );

    renderRepositoriesSettings();

    expect(await screen.findByText('yura/app')).toBeInTheDocument();
    expect(screen.getByText("GitHub managed by the deployment's access token (GITHUB_ACCESS_TOKEN)")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage GitHub connection' })).not.toBeInTheDocument();
  });
});
