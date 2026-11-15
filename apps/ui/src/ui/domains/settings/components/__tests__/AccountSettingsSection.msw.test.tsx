import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

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

describe('AccountSettingsSection with Google sign-in', () => {
  function stubGoogleAccount() {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({
          authenticated: true,
          provider: 'better-auth',
          user: { userId: 'user-1', email: 'ada@example.com', name: 'Ada', organizationId: 'org-1', permissions: ['board.read', 'self.write'] },
        }),
      ),
      http.get(`${TEST_BASE_URL}/auth/api/list-sessions`, () =>
        HttpResponse.json([
          {
            id: 's-here',
            token: 't-here',
            createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            ipAddress: '100.64.0.7',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
          },
          {
            id: 's-phone',
            token: 't-phone',
            createdAt: new Date(Date.now() - 86_400_000).toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            ipAddress: null,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
          },
        ]),
      ),
      http.get(`${TEST_BASE_URL}/auth/api/get-session`, () => HttpResponse.json({ session: { id: 's-here', token: 't-here' } })),
    );
  }

  it('edits the name in place', async () => {
    stubGoogleAccount();
    const updated = vi.fn();
    server.use(
      http.post(`${TEST_BASE_URL}/auth/api/update-user`, async ({ request }) => {
        updated(await request.json());
        return HttpResponse.json({ status: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AccountSettingsSection />);

    await user.click(await screen.findByRole('button', { name: 'Edit name' }));
    const input = screen.getByLabelText('Your name');
    await user.clear(input);
    await user.type(input, 'Ada L.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updated).toHaveBeenCalledWith({ name: 'Ada L.' }));
  });

  it('lists where the person is signed in, marks this session and signs another out', async () => {
    stubGoogleAccount();
    const revoked = vi.fn();
    server.use(
      http.post(`${TEST_BASE_URL}/auth/api/revoke-session`, async ({ request }) => {
        revoked(await request.json());
        return HttpResponse.json({ status: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AccountSettingsSection />);

    expect(await screen.findByText('Safari on macOS')).toBeInTheDocument();
    expect(screen.getByText('Current session')).toBeInTheDocument();
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
    expect(screen.getByText(/unknown IP/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out of Safari on iOS' }));

    await waitFor(() => expect(revoked).toHaveBeenCalledWith({ token: 't-phone' }));
    expect(screen.getByRole('button', { name: 'Sign out everywhere else' })).toBeInTheDocument();
  });
});
