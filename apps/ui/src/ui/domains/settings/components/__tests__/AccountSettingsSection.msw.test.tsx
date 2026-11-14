import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { AccountSettingsSection } from '../AccountSettingsSection';

function stubAuthenticatedAccount() {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({
        authenticated: true,
        user: {
          userId: 'user-1',
          email: 'dev@mastra.ai',
          name: 'Dev',
          organizationId: 'org-1',
        },
        provider: 'custom-sso',
      }),
    ),
  );
}

describe('AccountSettingsSection', () => {
  describe('when the user is signed in', () => {
    it('shows the profile returned by the auth endpoint', async () => {
      stubAuthenticatedAccount();

      renderWithProviders(<AccountSettingsSection />);

      expect(await screen.findByText('Dev')).toBeInTheDocument();
      expect(screen.getByText('dev@mastra.ai')).toBeInTheDocument();
      expect(screen.getByText('Custom Sso')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Account ID' })).toHaveValue('user-1');
      expect(screen.getByRole('button', { name: 'Copy account ID' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Organization ID' })).toHaveValue('org-1');
      expect(screen.getByRole('button', { name: 'Copy organization ID' })).toBeInTheDocument();
    });

    it("offers the person's own GitHub account here, once the organization has GitHub connected", async () => {
      stubAuthenticatedAccount();
      server.use(
        http.get(`${TEST_BASE_URL}/web/github/status`, () =>
          HttpResponse.json({
            enabled: true,
            appConfigured: true,
            connected: true,
            userConnected: false,
            installations: [{ id: 'inst-1', installationId: 1, accountLogin: 'eclipt-ai', accountType: 'Organization' }],
            reason: 'ready',
          }),
        ),
      );

      renderWithProviders(<AccountSettingsSection />);

      expect(await screen.findByText('GitHub account')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument();
    });

    it('shows no GitHub account on a server without a GitHub App', async () => {
      stubAuthenticatedAccount();
      server.use(
        http.get(`${TEST_BASE_URL}/web/github/status`, () =>
          HttpResponse.json({
            enabled: true,
            appConfigured: false,
            connected: true,
            userConnected: false,
            installations: [{ id: 'inst-1', installationId: 1, accountLogin: 'eclipt-ai', accountType: 'User', kind: 'token' }],
            reason: 'ready',
          }),
        ),
      );

      renderWithProviders(<AccountSettingsSection />);

      expect(await screen.findByText('Dev')).toBeInTheDocument();
      expect(screen.queryByText('GitHub account')).not.toBeInTheDocument();
    });

    it('names Google as the sign-in on better-auth deploys', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/auth/me`, () =>
          HttpResponse.json({
            authenticated: true,
            user: { userId: 'user-1', email: 'dev@mastra.ai', name: 'Dev', organizationId: 'org-1' },
            provider: 'better-auth',
          }),
        ),
      );

      renderWithProviders(<AccountSettingsSection />);

      expect(await screen.findByText('Google')).toBeInTheDocument();
    });

    it('logs out by clearing MastraCode storage', async () => {
      stubAuthenticatedAccount();
      localStorage.setItem('mastracode.theme', 'dark');

      renderWithProviders(<AccountSettingsSection />);
      await userEvent.click(await screen.findByRole('button', { name: 'Log out of Factory' }));

      expect(localStorage.getItem('mastracode.theme')).toBeNull();
    });
  });

  describe('when authentication is disabled', () => {
    it('explains why account actions are unavailable', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/auth/me`, () => HttpResponse.json({ error: 'not_found' }, { status: 404 })),
      );

      renderWithProviders(<AccountSettingsSection />);

      expect(await screen.findByText('Authentication is not enabled for this deployment.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Log out of Factory' })).not.toBeInTheDocument();
    });
  });
});
