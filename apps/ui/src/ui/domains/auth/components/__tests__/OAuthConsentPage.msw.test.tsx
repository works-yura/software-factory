/**
 * `/oauth/consent` and the sign-in step before it, through the real route table: an MCP client
 * (Claude Code) on Factory's own OAuth server asks to act as the person, who allows or denies it
 * (better-auth's OAuth provider endpoints, MSW).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { createAppRoutes } from '../../../../router';
import { openGoogleSignIn } from '../../services/auth';
import type * as AuthService from '../../services/auth';
import { returnToOAuthClient } from '../../services/oauth-consent';
import type * as ConsentService from '../../services/oauth-consent';

vi.mock('../../services/oauth-consent', async importOriginal => {
  const actual = await importOriginal<typeof ConsentService>();
  return { ...actual, returnToOAuthClient: vi.fn() };
});
vi.mock('../../services/auth', async importOriginal => {
  const actual = await importOriginal<typeof AuthService>();
  return { ...actual, openGoogleSignIn: vi.fn() };
});

const OAUTH_API = `${TEST_BASE_URL}/auth/api/oauth2`;
/** What the OAuth provider appends to the consent and login pages: the signed authorization request. */
const SIGNED_QUERY =
  'response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2Flocalhost%3A33418%2Fcallback&scope=openid+offline_access&state=st&exp=1900000000&iat=1794477642000&sig=abc';

function signedInAs(email: string | null) {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json(
        email
          ? { authenticated: true, provider: 'better-auth', user: { userId: 'ada', email, organizationId: 'org-ada' } }
          : { authenticated: false, user: null, provider: 'better-auth' },
      ),
    ),
    http.get(`${TEST_BASE_URL}/web/factories`, () => HttpResponse.json({ factories: [] })),
  );
}

function render(path: string) {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] });
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  vi.mocked(returnToOAuthClient).mockClear();
  vi.mocked(openGoogleSignIn).mockClear();
});

describe('OAuthConsentPage', () => {
  it('names the client and what it asks for, allows it with the signed request, and returns to the client', async () => {
    signedInAs('ada@example.com');
    const answered = vi.fn();
    server.use(
      http.get(`${OAUTH_API}/public-client`, ({ request }) =>
        new URL(request.url).searchParams.get('client_id') === 'client-1'
          ? HttpResponse.json({ client_id: 'client-1', client_name: 'Claude Code' })
          : HttpResponse.json({ error: 'not_found' }, { status: 404 }),
      ),
      http.post(`${OAUTH_API}/consent`, async ({ request }) => {
        answered(await request.json());
        return HttpResponse.json({ redirect: true, url: 'http://localhost:33418/callback?code=c0de&state=st' });
      }),
    );
    render(`/oauth/consent?${SIGNED_QUERY}`);

    expect(await screen.findByText(/Claude Code asks to use Factory as you/)).toBeInTheDocument();
    expect(screen.getByText('You are signed in as ada@example.com.')).toBeInTheDocument();
    const scopes = screen.getByRole('list', { name: 'It asks for' });
    expect(scopes).toHaveTextContent('Your Factory account id');
    expect(scopes).toHaveTextContent('Staying connected until you sign out');

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() => expect(returnToOAuthClient).toHaveBeenCalledWith('http://localhost:33418/callback?code=c0de&state=st'));
    expect(answered).toHaveBeenCalledWith({ accept: true, oauth_query: SIGNED_QUERY });
  });

  it('denies with the same request', async () => {
    signedInAs('ada@example.com');
    const answered = vi.fn();
    server.use(
      http.get(`${OAUTH_API}/public-client`, () => HttpResponse.json({ client_id: 'client-1', client_name: 'Cursor' })),
      http.post(`${OAUTH_API}/consent`, async ({ request }) => {
        answered(await request.json());
        return HttpResponse.json({ redirect: true, url: 'http://localhost:33418/callback?error=access_denied&state=st' });
      }),
    );
    render(`/oauth/consent?${SIGNED_QUERY}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(returnToOAuthClient).toHaveBeenCalledWith('http://localhost:33418/callback?error=access_denied&state=st'));
    expect(answered).toHaveBeenCalledWith({ accept: false, oauth_query: SIGNED_QUERY });
  });

  it('says why when the provider refuses the answer', async () => {
    signedInAs('ada@example.com');
    server.use(
      http.get(`${OAUTH_API}/public-client`, () => HttpResponse.json({ client_id: 'client-1', client_name: 'Claude Code' })),
      http.post(`${OAUTH_API}/consent`, () => HttpResponse.json({ error: 'invalid_signature' }, { status: 400 })),
    );
    render(`/oauth/consent?${SIGNED_QUERY}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work: invalid_signature');
    expect(returnToOAuthClient).not.toHaveBeenCalled();
  });

  it('refuses a page opened without the signed request', async () => {
    signedInAs('ada@example.com');
    render('/oauth/consent?client_id=client-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Connect from the client again');
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('signs a signed-out person in for the client: Google sign-in carries the signed request', async () => {
    signedInAs(null);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`${TEST_BASE_URL}/auth/api/sign-in/social`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', redirect: false });
      }),
    );
    render(`/signin?${SIGNED_QUERY}`);

    expect(await screen.findByText(/An MCP client asks to connect to Factory/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));

    await waitFor(() => expect(openGoogleSignIn).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'));
    expect(body).toMatchObject({ provider: 'google', oauth_query: SIGNED_QUERY });
  });
});
