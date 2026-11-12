/**
 * Settings › Організація against better-auth's organization endpoints (MSW keeps a small
 * in-memory organization so invites, cancels and removals show up on the next read).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../e2e/ui/render';
import { reloadIntoOrganization } from '../../../auth/services/organization';
import type * as OrganizationService from '../../../auth/services/organization';
import type { FullOrganization, OrganizationInvitation, OrganizationRole } from '../../../auth/services/organization';
import { OrganizationSection } from '../OrganizationSection';

// jsdom cannot follow a full-page navigation; the reload helper is the boundary.
vi.mock('../../../auth/services/organization', async importOriginal => {
  const actual = await importOriginal<typeof OrganizationService>();
  return { ...actual, reloadIntoOrganization: vi.fn() };
});

const ORG_API = `${TEST_BASE_URL}/auth/api/organization`;
const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

let organization: FullOrganization;
let organizations: Array<{ id: string; name: string; slug: string }>;
const calls = { invite: vi.fn(), cancel: vi.fn(), remove: vi.fn(), setActive: vi.fn() };

function signedInAs(userId: string) {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({
        authenticated: true,
        provider: 'better-auth',
        user: { userId, email: `${userId}@example.com`, name: userId, organizationId: 'org-acme' },
      }),
    ),
  );
}

beforeEach(() => {
  organization = {
    id: 'org-acme',
    name: 'Acme',
    slug: 'acme',
    members: [
      { id: 'm-ada', userId: 'ada', role: 'owner', user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } },
      { id: 'm-bob', userId: 'bob', role: 'member', user: { id: 'bob', name: 'Bob', email: 'bob@example.com' } },
    ],
    invitations: [
      { id: 'inv-old', email: 'old@example.com', role: 'member', status: 'canceled', expiresAt: IN_A_WEEK, organizationId: 'org-acme' },
      { id: 'inv-eve', email: 'eve@example.com', role: 'member', status: 'pending', expiresAt: IN_A_WEEK, organizationId: 'org-acme' },
    ],
  };
  organizations = [{ id: 'org-acme', name: 'Acme', slug: 'acme' }];
  server.use(
    http.get(`${ORG_API}/get-full-organization`, ({ request }) => {
      const id = new URL(request.url).searchParams.get('organizationId');
      return id === organization.id ? HttpResponse.json(organization) : HttpResponse.json({ code: 'NOT_FOUND' }, { status: 400 });
    }),
    http.get(`${ORG_API}/list`, () => HttpResponse.json(organizations)),
    http.post(`${ORG_API}/invite-member`, async ({ request }) => {
      const body = (await request.json()) as { email: string; role: OrganizationRole; organizationId: string };
      calls.invite(body);
      const invitation: OrganizationInvitation = {
        id: `inv-${body.email.split('@')[0]}`,
        email: body.email,
        role: body.role,
        status: 'pending',
        expiresAt: IN_A_WEEK,
        organizationId: body.organizationId,
      };
      organization = { ...organization, invitations: [...organization.invitations, invitation] };
      return HttpResponse.json(invitation);
    }),
    http.post(`${ORG_API}/cancel-invitation`, async ({ request }) => {
      const body = (await request.json()) as { invitationId: string };
      calls.cancel(body);
      organization = {
        ...organization,
        invitations: organization.invitations.map(invitation =>
          invitation.id === body.invitationId ? { ...invitation, status: 'canceled' } : invitation,
        ),
      };
      return HttpResponse.json({});
    }),
    http.post(`${ORG_API}/remove-member`, async ({ request }) => {
      const body = (await request.json()) as { memberIdOrEmail: string; organizationId: string };
      calls.remove(body);
      organization = { ...organization, members: organization.members.filter(member => member.id !== body.memberIdOrEmail) };
      return HttpResponse.json({ member: {} });
    }),
    http.post(`${ORG_API}/set-active`, async ({ request }) => {
      calls.setActive(await request.json());
      return HttpResponse.json(organizations[1]);
    }),
  );
});

afterEach(() => {
  for (const call of Object.values(calls)) call.mockReset();
  vi.mocked(reloadIntoOrganization).mockClear();
});

describe('OrganizationSection', () => {
  describe('as the owner', () => {
    it('shows the organization, your role and the members with the owner marked', async () => {
      signedInAs('ada');
      renderWithProviders(<OrganizationSection />);

      expect(await screen.findByTestId('organization-name')).toHaveTextContent('Acme');
      expect(screen.getByText('Ada (you)')).toBeInTheDocument();
      expect(screen.getByText('bob@example.com')).toBeInTheDocument();
      expect(screen.getAllByText('Owner').length).toBeGreaterThanOrEqual(2);
      // The owner cannot be removed; other members can.
      expect(screen.queryByRole('button', { name: 'Remove Ada' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove Bob' })).toBeInTheDocument();
    });

    it('creates an invitation link for the email, as a member, with a copy button', async () => {
      signedInAs('ada');
      const user = userEvent.setup();
      renderWithProviders(<OrganizationSection />);

      await user.type(await screen.findByLabelText('Email to invite'), 'carol@example.com');
      await user.click(screen.getByRole('button', { name: 'Create invitation link' }));

      expect(await screen.findByTestId('invitation-link')).toHaveTextContent(`${window.location.origin}/invite/inv-carol`);
      expect(calls.invite).toHaveBeenCalledWith({ email: 'carol@example.com', role: 'member', organizationId: 'org-acme' });
      await user.click(screen.getByRole('button', { name: 'Copy invitation link' }));
      expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/invite/inv-carol`);
      // It also joins the pending list.
      expect(await screen.findByRole('button', { name: 'Cancel invitation for carol@example.com' })).toBeInTheDocument();
    });

    it('lists only open invitations, copies their link and cancels one', async () => {
      signedInAs('ada');
      const user = userEvent.setup();
      renderWithProviders(<OrganizationSection />);

      await user.click(await screen.findByRole('button', { name: 'Copy link for eve@example.com' }));
      expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/invite/inv-eve`);
      expect(screen.queryByText('old@example.com')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel invitation for eve@example.com' }));

      expect(calls.cancel).toHaveBeenCalledWith({ invitationId: 'inv-eve' });
      expect(await screen.findByText('No pending invitations.')).toBeInTheDocument();
    });

    it('removes a member after confirming', async () => {
      signedInAs('ada');
      const user = userEvent.setup();
      renderWithProviders(<OrganizationSection />);

      await user.click(await screen.findByRole('button', { name: 'Remove Bob' }));
      const dialog = await screen.findByRole('alertdialog', { name: 'Remove Bob from Acme?' });
      await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(calls.remove).toHaveBeenCalledWith({ memberIdOrEmail: 'm-bob', organizationId: 'org-acme' }));
      await waitFor(() => expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument());
    });

    it('says why the server refused an invitation', async () => {
      signedInAs('ada');
      server.use(
        http.post(`${ORG_API}/invite-member`, () =>
          HttpResponse.json(
            { code: 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION', message: 'User is already a member of this organization' },
            { status: 400 },
          ),
        ),
      );
      const user = userEvent.setup();
      renderWithProviders(<OrganizationSection />);

      await user.type(await screen.findByLabelText('Email to invite'), 'bob@example.com');
      await user.click(screen.getByRole('button', { name: 'Create invitation link' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('User is already a member of this organization');
      expect(screen.queryByTestId('invitation-link')).not.toBeInTheDocument();
    });
  });

  describe('as a member', () => {
    it('shows the organization and members but no way to invite or remove', async () => {
      signedInAs('bob');
      renderWithProviders(<OrganizationSection />);

      expect(await screen.findByTestId('organization-name')).toHaveTextContent('Acme');
      expect(screen.getByText('Bob (you)')).toBeInTheDocument();
      expect(screen.getAllByText('Member').length).toBeGreaterThanOrEqual(2);
      expect(screen.queryByLabelText('Email to invite')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
      expect(screen.queryByText('Pending invitations')).not.toBeInTheDocument();
    });
  });

  it('switches to another organization and reloads the app in it', async () => {
    organizations = [...organizations, { id: 'org-ada', name: "ada@example.com's org", slug: 'personal-ada' }];
    signedInAs('ada');
    const user = userEvent.setup();
    renderWithProviders(<OrganizationSection />);

    expect(await screen.findByText('Current')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Switch to ada@example.com's org" }));

    await waitFor(() => expect(reloadIntoOrganization).toHaveBeenCalled());
    expect(calls.setActive).toHaveBeenCalledWith({ organizationId: 'org-ada' });
  });

  it('says when your organizations cannot be listed instead of hiding the switcher', async () => {
    server.use(
      http.get(`${ORG_API}/list`, () => HttpResponse.json({ message: 'Database is unavailable' }, { status: 500 })),
    );
    signedInAs('ada');
    renderWithProviders(<OrganizationSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your organizations: Database is unavailable');
    // The organization itself still shows.
    expect(screen.getByTestId('organization-name')).toHaveTextContent('Acme');
  });

  it('reports a response that is not better-auth JSON as a failed request, not an empty organization', async () => {
    server.use(
      http.get(`${ORG_API}/get-full-organization`, () => new HttpResponse('<html>proxy</html>', { status: 200 })),
    );
    signedInAs('ada');
    renderWithProviders(<OrganizationSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the organization: The organization request failed (200).',
    );
  });

  it('explains that organizations come with Google sign-in on other providers', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({
          authenticated: true,
          provider: 'custom-sso',
          user: { userId: 'dev', email: 'dev@localhost', organizationId: 'factory-local-org' },
        }),
      ),
    );
    renderWithProviders(<OrganizationSection />);

    expect(await screen.findByText(/Organizations, members and invitations come with Google sign-in/)).toBeInTheDocument();
  });
});
