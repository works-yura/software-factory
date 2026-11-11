/**
 * `/invite/:invitationId` through the real route table: the sign-in guard keeps the link as
 * `returnTo`, and a signed-in person accepts or declines through better-auth's invitation
 * endpoints (MSW).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { createAppRoutes } from '../../../../router';
import { redirectToLogout } from '../../services/auth';
import type * as AuthService from '../../services/auth';
import { reloadIntoOrganization } from '../../services/organization';
import type * as OrganizationService from '../../services/organization';

vi.mock('../../services/organization', async importOriginal => {
  const actual = await importOriginal<typeof OrganizationService>();
  return { ...actual, reloadIntoOrganization: vi.fn() };
});
vi.mock('../../services/auth', async importOriginal => {
  const actual = await importOriginal<typeof AuthService>();
  return { ...actual, redirectToLogout: vi.fn() };
});

const ORG_API = `${TEST_BASE_URL}/auth/api/organization`;
const INVITATION = {
  id: 'inv-1',
  email: 'bob@example.com',
  role: 'member',
  status: 'pending',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  organizationId: 'org-acme',
  inviterId: 'ada',
  organizationName: 'Acme',
  organizationSlug: 'acme',
  inviterEmail: 'ada@example.com',
};

function signedInAs(email: string | null) {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json(
        email
          ? {
              authenticated: true,
              provider: 'better-auth',
              user: { userId: email.split('@')[0], email, organizationId: 'org-personal' },
            }
          : { authenticated: false, user: null, provider: 'better-auth' },
      ),
    ),
    // A brand-new invited person has no Factory yet: the invite page must not send them to onboarding.
    http.get(`${TEST_BASE_URL}/web/factories`, () => HttpResponse.json({ factories: [] })),
  );
}

function renderInvite(path = '/invite/inv-1') {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] });
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  vi.mocked(reloadIntoOrganization).mockClear();
  vi.mocked(redirectToLogout).mockClear();
});

describe('InvitePage', () => {
  it('sends a signed-out visitor to sign in and back to the invitation', async () => {
    signedInAs(null);
    const router = renderInvite();

    await screen.findByRole('button', { name: 'Sign in with Google' });
    expect(router.state.location.pathname).toBe('/signin');
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/invite/inv-1');
  });

  it('shows who invited whom where, accepts, makes the organization active and opens the app in it', async () => {
    signedInAs('bob@example.com');
    const accepted = vi.fn();
    const activated = vi.fn();
    server.use(
      http.get(`${ORG_API}/get-invitation`, ({ request }) =>
        new URL(request.url).searchParams.get('id') === 'inv-1'
          ? HttpResponse.json(INVITATION)
          : HttpResponse.json({ message: 'Invitation not found!' }, { status: 400 }),
      ),
      http.post(`${ORG_API}/accept-invitation`, async ({ request }) => {
        accepted(await request.json());
        return HttpResponse.json({ invitation: { ...INVITATION, status: 'accepted' }, member: { id: 'm-bob' } });
      }),
      http.post(`${ORG_API}/set-active`, async ({ request }) => {
        activated(await request.json());
        return HttpResponse.json({ id: 'org-acme', name: 'Acme', slug: 'acme' });
      }),
    );
    const router = renderInvite();

    expect(await screen.findByRole('heading', { name: 'Invitation to Acme' })).toBeInTheDocument();
    expect(screen.getByText('ada@example.com invited you to join Acme as a member.')).toBeInTheDocument();
    expect(screen.getByText('You are signed in as bob@example.com.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/invite/inv-1');

    await userEvent.click(screen.getByRole('button', { name: 'Accept and open' }));

    await waitFor(() => expect(reloadIntoOrganization).toHaveBeenCalled());
    expect(accepted).toHaveBeenCalledWith({ invitationId: 'inv-1' });
    expect(activated).toHaveBeenCalledWith({ organizationId: 'org-acme' });
  });

  it('explains a wrong email and offers to sign out to switch accounts', async () => {
    signedInAs('eve@example.com');
    server.use(
      http.get(`${ORG_API}/get-invitation`, () =>
        HttpResponse.json(
          { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION', message: 'You are not the recipient of the invitation' },
          { status: 403 },
        ),
      ),
    );
    renderInvite();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This invitation is for a different email. You are signed in as eve@example.com',
    );
    expect(screen.queryByRole('button', { name: 'Accept and open' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(redirectToLogout).toHaveBeenCalledWith(TEST_BASE_URL);
  });

  it('says an expired or used invitation needs a new link', async () => {
    signedInAs('bob@example.com');
    server.use(
      http.get(`${ORG_API}/get-invitation`, () => HttpResponse.json({ message: 'Invitation not found!' }, { status: 400 })),
    );
    renderInvite();

    expect(await screen.findByRole('alert')).toHaveTextContent('This invitation has expired, was cancelled, or was already used');
  });

  it('declines without joining', async () => {
    signedInAs('bob@example.com');
    const rejected = vi.fn();
    server.use(
      http.get(`${ORG_API}/get-invitation`, () => HttpResponse.json(INVITATION)),
      http.post(`${ORG_API}/reject-invitation`, async ({ request }) => {
        rejected(await request.json());
        return HttpResponse.json({ invitation: { ...INVITATION, status: 'rejected' }, member: null });
      }),
    );
    renderInvite();

    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));

    expect(await screen.findByText('You declined the invitation.')).toBeInTheDocument();
    expect(rejected).toHaveBeenCalledWith({ invitationId: 'inv-1' });
    expect(reloadIntoOrganization).not.toHaveBeenCalled();
  });
});
