/**
 * BDD coverage for the provider-aware /signin page.
 *
 * Drives the real route table (SignInGate → SignInPage) through a memory
 * router with MSW stubbing `/auth/me` and better-auth's social sign-in
 * endpoint. Hosted-login (SSO) deploys keep the redirect button; better-auth
 * deploys get only "Sign in with Google", which leaves for Google.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { openGoogleSignIn, redirectToLogin } from '../../services/auth';
import type * as AuthService from '../../services/auth';
import { createAppRoutes } from '../../../../router';
import { safeReturnTo, SignInPage } from '../../../../pages/SignInPage';
import { queryKeys } from '../../../../../api/keys';
import { createQueryClient } from '../../../../../query-client';
import { signedIn, signedOut } from './fixtures/auth';

// jsdom's `window.location.assign` is unforgeable (cannot be spied on), so the
// service-level navigation helpers are stubbed instead; `fetchAuthState` and
// `signInWithGoogle` stay real so MSW sees the actual requests.
vi.mock('../../services/auth', async importOriginal => {
  const actual = await importOriginal<typeof AuthService>();
  return { ...actual, redirectToLogin: vi.fn(), openGoogleSignIn: vi.fn() };
});

const AUTH_ME_URL = `${TEST_BASE_URL}/auth/me`;

afterEach(() => {
  vi.mocked(redirectToLogin).mockClear();
  vi.mocked(openGoogleSignIn).mockClear();
});

function stubAuthMe(body: Record<string, unknown>) {
  server.use(http.get(AUTH_ME_URL, () => HttpResponse.json({ authenticated: false, user: null, ...body })));
}

function renderSignIn(initialEntry = '/signin') {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [initialEntry] });
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

describe('SignInPage', () => {
  describe('session revalidation before redirecting', () => {
    function renderCachedSignIn(cachedAuth?: AuthService.FactoryAuthState) {
      const client = createQueryClient();
      if (cachedAuth) client.setQueryData(queryKeys.factoryAuth(), cachedAuth);
      const router = createMemoryRouter(
        [
          { path: '/signin', element: <SignInPage /> },
          { path: '/factory/board', element: <h1>Work board</h1> },
        ],
        { initialEntries: ['/signin?returnTo=%2Ffactory%2Fboard%3Fview%3Dmine%23item-1'] },
      );
      renderWithProviders(<RouterProvider router={router} />, client);
      return router;
    }

    it('checks a cached signed-in session before redirecting and stays on sign-in when it expired', async () => {
      let finishCheck = () => {};
      const checked = new Promise<void>(resolve => {
        finishCheck = resolve;
      });
      const requestSeen = vi.fn();
      server.use(
        http.get(AUTH_ME_URL, async () => {
          requestSeen();
          await checked;
          return HttpResponse.json(signedOut);
        }),
      );
      const router = renderCachedSignIn(signedIn);

      await waitFor(() => expect(requestSeen).toHaveBeenCalled());
      expect(router.state.location.pathname).toBe('/signin');
      expect(screen.queryByRole('heading', { name: 'Work board' })).not.toBeInTheDocument();

      finishCheck();
      expect(await screen.findByRole('button', { name: 'Continue to sign in' })).toBeEnabled();
      expect(router.state.location.pathname).toBe('/signin');
    });

    it('returns to the full destination when a fresh check confirms sign-in in another tab', async () => {
      server.use(http.get(AUTH_ME_URL, () => HttpResponse.json(signedIn)));
      const router = renderCachedSignIn(signedOut);

      await screen.findByRole('heading', { name: 'Work board' });
      expect(router.state.location.pathname).toBe('/factory/board');
      expect(router.state.location.search).toBe('?view=mine');
      expect(router.state.location.hash).toBe('#item-1');
    });

    it.each([undefined, signedIn])(
      'stays on sign-in after a failed check and offers a retry (cache: %j)',
      async cachedAuth => {
        server.use(http.get(AUTH_ME_URL, () => new HttpResponse(undefined, { status: 500 })));
        const router = renderCachedSignIn(cachedAuth);

        expect(await screen.findByRole('alert')).toHaveTextContent('Unable to check your sign-in status');
        expect(router.state.location.pathname).toBe('/signin');

        server.use(http.get(AUTH_ME_URL, () => HttpResponse.json(signedOut)));
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('button', { name: 'Continue to sign in' })).toBeEnabled();
        expect(router.state.location.pathname).toBe('/signin');
      },
    );
  });

  it('says Factory is unavailable (a server problem, not your sign-in) when /auth/me answers 503', async () => {
    server.use(http.get(AUTH_ME_URL, () => HttpResponse.json({ error: 'auth_unavailable' }, { status: 503 })));
    renderSignIn();

    expect(await screen.findByRole('alert')).toHaveTextContent('this is a server problem, not your sign-in');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders the agent factory welcome message without a separate page header', async () => {
    stubAuthMe({ provider: 'sso-fake' });
    renderSignIn();

    expect(await screen.findByRole('heading', { name: 'Build with an agent factory' })).toBeInTheDocument();
    expect(screen.getByText(/Turn a repository into a working factory/)).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });

  describe('given a hosted-login (SSO) deploy', () => {
    it('renders the hosted sign-in action and redirects to the login route', async () => {
      stubAuthMe({ provider: 'sso-fake' });
      renderSignIn('/signin?returnTo=%2Ffactory%2Fboard');

      const button = await screen.findByRole('button', { name: 'Continue to sign in' });
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

      await userEvent.click(button);
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('Redirecting to sign-in…');
      expect(redirectToLogin).toHaveBeenCalledWith(TEST_BASE_URL, '/factory/board');
    });
  });

  describe('given a better-auth (Google) deploy', () => {
    it('offers only the Google button, no email or password form', async () => {
      stubAuthMe({ provider: 'better-auth' });
      renderSignIn();

      expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Sign up/ })).not.toBeInTheDocument();
    });

    it("asks the server for Google's sign-in URL with the return path and leaves for it", async () => {
      stubAuthMe({ provider: 'better-auth' });
      const posted = vi.fn();
      server.use(
        http.post(`${TEST_BASE_URL}/auth/api/sign-in/social`, async ({ request }) => {
          posted(await request.json());
          return HttpResponse.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', redirect: false });
        }),
      );
      renderSignIn('/signin?returnTo=%2Finvite%2Finv-1');

      const button = await screen.findByRole('button', { name: 'Sign in with Google' });
      await userEvent.click(button);

      await waitFor(() =>
        expect(openGoogleSignIn).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'),
      );
      expect(posted).toHaveBeenCalledWith({
        provider: 'google',
        callbackURL: '/invite/inv-1',
        errorCallbackURL: '/signin?returnTo=%2Finvite%2Finv-1',
        disableRedirect: true,
      });
      expect(button).toHaveTextContent('Redirecting to Google…');
      expect(redirectToLogin).not.toHaveBeenCalled();
    });

    it('says why the server refused and lets the person try again', async () => {
      stubAuthMe({ provider: 'better-auth' });
      server.use(
        http.post(`${TEST_BASE_URL}/auth/api/sign-in/social`, () =>
          HttpResponse.json({ message: 'Provider not found', code: 'PROVIDER_NOT_FOUND' }, { status: 404 }),
        ),
      );
      renderSignIn();

      await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Provider not found');
      expect(openGoogleSignIn).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
    });

    it('shows the error Google sign-in came back with', async () => {
      stubAuthMe({ provider: 'better-auth' });
      renderSignIn('/signin?returnTo=%2F&error=unable_to_link_account');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Sign-in failed');
      expect(alert).toHaveTextContent('Error code: unable_to_link_account');
      expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeEnabled();
    });
  });

  describe('given an IdP access_denied redirect', () => {
    it('shows the denial with the IdP description and still allows a retry', async () => {
      stubAuthMe({ provider: 'sso-fake' });
      const description = encodeURIComponent('You do not have access to this application.');
      renderSignIn(`/signin?error=access_denied&error_description=${description}`);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Access denied');
      expect(alert).toHaveTextContent('You do not have access to this application.');
      expect(alert).toHaveTextContent('Ask an organization admin to add your account');

      await userEvent.click(await screen.findByRole('button', { name: 'Continue to sign in' }));
      expect(redirectToLogin).toHaveBeenCalledWith(TEST_BASE_URL, '/');
    });

    it('falls back to the admin hint when the IdP sends no description', async () => {
      stubAuthMe({ provider: 'sso-fake' });
      renderSignIn('/signin?error=access_denied');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Access denied');
      expect(alert).toHaveTextContent('Ask an organization admin to add your account');
    });
  });

  describe('returnTo sanitization', () => {
    it.each([
      ['/factory/board?x=1#frag', '/factory/board?x=1#frag'],
      ['//attacker.example', '/'],
      // Browsers normalize `/\` to `//` — an encoded backslash must not
      // become a protocol-relative cross-origin redirect.
      ['/\\attacker.example', '/'],
      ['/\\/attacker.example', '/'],
      ['https://attacker.example/x', '/'],
      ['javascript:alert(1)', '/'],
      [undefined, '/'],
    ])('resolves %s to %s against the page origin', (raw, expected) => {
      expect(safeReturnTo(raw)).toBe(expected);
    });
  });
});
