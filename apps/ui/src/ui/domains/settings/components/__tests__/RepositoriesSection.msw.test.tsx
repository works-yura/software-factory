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
    expect(screen.queryByText('Optional: tokens for the gh CLI')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sandbox' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Setup command for/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Environment' })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/settings/environment`,
    );
    // Connecting GitLab (another account, managing it) is in Інтеграції; here only a link there.
    expect(screen.queryByRole('button', { name: 'Connect another GitLab account' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Connections' })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/settings/integrations`,
    );
    expect(screen.queryByText('Worker token (optional)')).not.toBeInTheDocument();
  });

  it('never connects GitHub here: connecting is in Підключення, linked from this page', async () => {
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
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument();
    expect(screen.getByText(/GitHub and GitLab are connected under Connections/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Connections' })).toHaveAttribute(
      'href',
      `/factories/${FACTORY_ID}/settings/integrations`,
    );
  });

  it('lists GitHub repositories of a token connection with no Connect or Manage step, beside GitLab', async () => {
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
          appConfigured: true,
          connected: true,
          installations: [{ id: 'inst-gh', installationId: 4242, accountLogin: 'yura', accountType: 'User', kind: 'token', tokenSource: 'stored' }],
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
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage GitHub connection' })).not.toBeInTheDocument();
    // Org-wide gh CLI tokens live on the GitHub connection's page, the person's GitHub account in My account.
    expect(screen.queryByText('Optional: tokens for the gh CLI')).not.toBeInTheDocument();
    expect(screen.queryByText('Worker token (optional)')).not.toBeInTheDocument();
  });
});
