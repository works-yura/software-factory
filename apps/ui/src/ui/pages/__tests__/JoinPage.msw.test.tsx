/**
 * `/join/:token` against Factory's join-link routes (ADR-0045): the page names the organization
 * and role, joins, makes the organization active and opens the app in it; a refusal is explained.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../e2e/ui/render';
import { reloadIntoOrganization } from '../../domains/auth/services/organization';
import type * as OrganizationService from '../../domains/auth/services/organization';
import { createAppRoutes } from '../../router';

vi.mock('../../domains/auth/services/organization', async importOriginal => {
  const actual = await importOriginal<typeof OrganizationService>();
  return { ...actual, reloadIntoOrganization: vi.fn() };
});

function signedInAs(email: string | null) {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json(
        email
          ? { authenticated: true, provider: 'better-auth', user: { userId: 'dan', email, organizationId: 'org-personal' } }
          : { authenticated: false, user: null, provider: 'better-auth' },
      ),
    ),
    http.get(`${TEST_BASE_URL}/web/factories`, () => HttpResponse.json({ factories: [] })),
  );
}

function preview(overrides: Record<string, unknown> = {}) {
  return { organization: { id: 'org-acme', name: 'Acme', logo: null }, role: 'viewer', name: 'Engineering', alreadyMember: false, refusal: null, ...overrides };
}

function renderJoin(path = '/join/tok-1') {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [path] });
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

afterEach(() => vi.mocked(reloadIntoOrganization).mockClear());

describe('JoinPage', () => {
  it('sends a signed-out visitor to sign in and back to the link', async () => {
    signedInAs(null);
    const router = renderJoin();

    await screen.findByRole('button', { name: 'Sign in with Google' });
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/join/tok-1');
  });

  it('names the organization and role, joins, makes it active and opens the app in it', async () => {
    signedInAs('dan@acme.com');
    const accepted = vi.fn();
    const activated = vi.fn();
    server.use(
      http.get(`${TEST_BASE_URL}/web/join/tok-1`, () => HttpResponse.json(preview())),
      http.post(`${TEST_BASE_URL}/web/join/tok-1/accept`, () => {
        accepted();
        return HttpResponse.json({ organizationId: 'org-acme', role: 'viewer', alreadyMember: false });
      }),
      http.post(`${TEST_BASE_URL}/auth/api/organization/set-active`, async ({ request }) => {
        activated(await request.json());
        return HttpResponse.json({ id: 'org-acme', name: 'Acme', slug: 'acme' });
      }),
    );
    renderJoin();

    expect(await screen.findByRole('heading', { name: 'Join Acme' })).toBeInTheDocument();
    expect(screen.getByText('You join Acme with the Viewer role.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Join and open' }));

    await waitFor(() => expect(reloadIntoOrganization).toHaveBeenCalled());
    expect(accepted).toHaveBeenCalledOnce();
    expect(activated).toHaveBeenCalledWith({ organizationId: 'org-acme' });
  });

  it('explains a domain the link does not admit and offers to sign out', async () => {
    signedInAs('eve@evil.com');
    server.use(http.get(`${TEST_BASE_URL}/web/join/tok-1`, () => HttpResponse.json(preview({ refusal: 'domain_not_allowed' }))));
    renderJoin();

    expect(await screen.findByRole('alert')).toHaveTextContent('This join link does not admit eve@evil.com.');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join and open' })).not.toBeInTheDocument();
  });

  it('explains a link used up between opening and joining', async () => {
    signedInAs('dan@acme.com');
    server.use(
      http.get(`${TEST_BASE_URL}/web/join/tok-1`, () => HttpResponse.json(preview())),
      http.post(`${TEST_BASE_URL}/web/join/tok-1/accept`, () =>
        HttpResponse.json({ error: 'join_link_used_up', refusal: 'used_up' }, { status: 403 }),
      ),
    );
    renderJoin();

    await userEvent.click(await screen.findByRole('button', { name: 'Join and open' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('used as many times as it allows');
    expect(reloadIntoOrganization).not.toHaveBeenCalled();
  });

  it('says when the link does not exist', async () => {
    signedInAs('dan@acme.com');
    server.use(
      http.get(`${TEST_BASE_URL}/web/join/nope`, () =>
        HttpResponse.json({ error: 'join_link_not_found', message: 'This join link does not exist.' }, { status: 404 }),
      ),
    );
    renderJoin('/join/nope');

    expect(await screen.findByRole('alert')).toHaveTextContent('This join link does not exist. Check that you copied all of it.');
  });
});
