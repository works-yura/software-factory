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
import { TeamSection } from '../TeamSection';

// jsdom cannot follow a full-page navigation; the reload helper is the boundary.
vi.mock('../../../auth/services/organization', async importOriginal => {
  const actual = await importOriginal<typeof OrganizationService>();
  return { ...actual, reloadIntoOrganization: vi.fn() };
});

const ORG_API = `${TEST_BASE_URL}/auth/api/organization`;
const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

let organization: FullOrganization;
let organizations: Array<{ id: string; name: string; slug: string }>;
const calls = { invite: vi.fn(), cancel: vi.fn(), remove: vi.fn(), setActive: vi.fn(), role: vi.fn(), update: vi.fn(), leave: vi.fn(), createLink: vi.fn(), revokeLink: vi.fn() };
let joinLinks: Array<Record<string, unknown>>;

const MEMBER_PERMISSIONS = ['board.read', 'self.write', 'card.write', 'comment.write', 'run.start', 'session.write', 'factory.configure'];
const ADMIN_PERMISSIONS = [...MEMBER_PERMISSIONS, 'factory.manage', 'connections.manage', 'org.manage', 'members.manage', 'join-links.manage', 'content.moderate'];
const PERMISSIONS_OF: Record<string, string[]> = { ada: ADMIN_PERMISSIONS, bob: MEMBER_PERMISSIONS, vera: ['board.read', 'self.write'] };

function signedInAs(userId: string) {
  server.use(
    http.get(`${TEST_BASE_URL}/auth/me`, () =>
      HttpResponse.json({
        authenticated: true,
        provider: 'better-auth',
        user: { userId, email: `${userId}@example.com`, name: userId, organizationId: 'org-acme', permissions: PERMISSIONS_OF[userId] },
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
  joinLinks = [];
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
    http.post(`${ORG_API}/update-member-role`, async ({ request }) => {
      const body = (await request.json()) as { memberId: string; role: OrganizationRole };
      calls.role(body);
      organization = {
        ...organization,
        members: organization.members.map(member => (member.id === body.memberId ? { ...member, role: body.role } : member)),
      };
      return HttpResponse.json({});
    }),
    http.post(`${ORG_API}/update`, async ({ request }) => {
      const body = (await request.json()) as { data: { name?: string } };
      calls.update(body);
      organization = { ...organization, ...body.data };
      return HttpResponse.json(organization);
    }),
    http.post(`${ORG_API}/leave`, async ({ request }) => {
      calls.leave(await request.json());
      return HttpResponse.json({});
    }),
    http.get(`${TEST_BASE_URL}/web/org/join-links`, () => HttpResponse.json({ joinLinks })),
    http.post(`${TEST_BASE_URL}/web/org/join-links`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.createLink(body);
      const link = { id: 'jl-1', organizationId: 'org-acme', token: 'tok-1', uses: 0, createdBy: 'ada', createdAt: new Date().toISOString(), revokedAt: null, status: 'active', ...body };
      joinLinks = [link, ...joinLinks];
      return HttpResponse.json(link, { status: 201 });
    }),
    http.post(`${TEST_BASE_URL}/web/org/join-links/:id/revoke`, ({ params }) => {
      calls.revokeLink(params.id);
      joinLinks = joinLinks.map(link => (link.id === params.id ? { ...link, status: 'revoked' } : link));
      return HttpResponse.json(joinLinks.find(link => link.id === params.id));
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

describe('TeamSection', () => {
  describe('as the owner', () => {
    it('lists members with their roles, the owner marked as an admin and owner', async () => {
      signedInAs('ada');
      renderWithProviders(<TeamSection />);

      expect(await screen.findByText('Ada (you)')).toBeInTheDocument();
      expect(screen.getByText('2 members')).toBeInTheDocument();
      expect(screen.getByText('owner')).toBeInTheDocument();
      // The owner cannot be removed or changed; other members can.
      expect(screen.queryByRole('button', { name: 'Remove Ada' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove Bob' })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Role of Bob' })).toHaveTextContent('Member');
    });

    it('changes a member’s role', async () => {
      signedInAs('ada');
      const user = userEvent.setup();
      renderWithProviders(<TeamSection />);

      await user.click(await screen.findByRole('combobox', { name: 'Role of Bob' }));
      await user.click(await screen.findByRole('option', { name: /Viewer/ }));

      await waitFor(() => expect(calls.role).toHaveBeenCalledWith({ memberId: 'm-bob', role: 'viewer', organizationId: 'org-acme' }));
      await waitFor(() => expect(screen.getByRole('combobox', { name: 'Role of Bob' })).toHaveTextContent('Viewer'));
    });

    it('invites by email with a role and shows the link to copy', async () => {
      signedInAs('ada');
      const user = userEvent.setup();
      renderWithProviders(<TeamSection />);

      await user.click(await screen.findByRole('button', { name: 'Invite member' }));
      const dialog = await screen.findByRole('dialog', { name: 'Invite member' });
      await user.type(within(dialog).getByLabelText('Email'), 'carol@example.com');
      await user.click(within(dialog).getByRole('combobox', { name: 'Role' }));
      await user.click(await screen.findByRole('option', { name: /Admin/ }));
      await user.click(within(dialog).getByRole('button', { name: 'Create link' }));

      expect(await screen.findByTestId('invitation-link')).toHaveTextContent(`${window.location.origin}/invite/inv-carol`);
      expect(calls.invite).toHaveBeenCalledWith({ email: 'carol@example.com', role: 'admin', organizationId: 'org-acme' });
      await user.click(screen.getByRole('button', { name: 'Copy invitation link' }));
      expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/invite/inv-carol`);
    });

    it('lists only open invitations with their role, copies their link and cancels one', async () => {
      signedInAs('ada');
      const user = userEvent.setup();
      renderWithProviders(<TeamSection />);

      await user.click(await screen.findByRole('button', { name: 'Copy link for eve@example.com' }));
      expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/invite/inv-eve`);
      expect(screen.getByText(/Member · expires/)).toBeInTheDocument();
      expect(screen.queryByText('old@example.com')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel invitation for eve@example.com' }));

      expect(calls.cancel).toHaveBeenCalledWith({ invitationId: 'inv-eve' });
      expect(await screen.findByText('No pending invitations.')).toBeInTheDocument();
    });

    it('removes a member after confirming', async () => {
      signedInAs('ada');
      const user = userEvent.setup();
      renderWithProviders(<TeamSection />);

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
      renderWithProviders(<TeamSection />);

      await user.click(await screen.findByRole('button', { name: 'Invite member' }));
      const dialog = await screen.findByRole('dialog', { name: 'Invite member' });
      await user.type(within(dialog).getByLabelText('Email'), 'bob@example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Create link' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('User is already a member of this organization');
      expect(screen.queryByTestId('invitation-link')).not.toBeInTheDocument();
    });

    it('creates a join link with a role, domains, expiry and limit, then copies and revokes it', async () => {
      signedInAs('ada');
      const user = userEvent.setup();
      renderWithProviders(<TeamSection />);

      expect(await screen.findByText('No join links.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Create join link' }));
      const dialog = await screen.findByRole('dialog', { name: 'Create join link' });
      await user.type(within(dialog).getByLabelText('Name'), 'Engineering');
      await user.click(within(dialog).getByRole('combobox', { name: 'Join as' }));
      await user.click(await screen.findByRole('option', { name: /Viewer/ }));
      await user.type(within(dialog).getByLabelText('Allowed email domains'), 'acme.com, research.acme.com');
      await user.click(within(dialog).getByRole('combobox', { name: 'Expires' }));
      await user.click(await screen.findByRole('option', { name: '7 days' }));
      await user.type(within(dialog).getByLabelText('Maximum uses'), '10');
      await user.click(within(dialog).getByRole('button', { name: 'Create join link' }));

      await waitFor(() => expect(calls.createLink).toHaveBeenCalledOnce());
      const body = calls.createLink.mock.calls[0]![0] as Record<string, unknown>;
      expect(body).toMatchObject({ name: 'Engineering', role: 'viewer', allowedDomains: ['acme.com', 'research.acme.com'], maxUses: 10 });
      const days = (new Date(body.expiresAt as string).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);

      expect(await screen.findByText('Engineering')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Copy join link Engineering' }));
      expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/join/tok-1`);
      await user.click(screen.getByRole('button', { name: 'Revoke join link Engineering' }));
      expect(calls.revokeLink).toHaveBeenCalledWith('jl-1');
      expect(await screen.findByText('Revoked')).toBeInTheDocument();
    });
  });

  describe('as a member', () => {
    it('shows the members but no way to invite, change roles, remove or make join links', async () => {
      signedInAs('bob');
      renderWithProviders(<TeamSection />);

      expect(await screen.findByText('Bob (you)')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Invite member' })).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: /Role of/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
      expect(screen.queryByText('Pending invitations')).not.toBeInTheDocument();
      expect(screen.queryByText('Join links')).not.toBeInTheDocument();
    });
  });
});

describe('OrganizationSection', () => {
  it('lets an admin rename the organization and shows its ID', async () => {
    signedInAs('ada');
    const user = userEvent.setup();
    renderWithProviders(<OrganizationSection />);

    const name = await screen.findByLabelText('Organization name');
    expect(screen.getByDisplayValue('org-acme')).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, 'Works');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.update).toHaveBeenCalledWith({ organizationId: 'org-acme', data: { name: 'Works' } }));
  });

  it('shows a member the name without editing, and lets them leave after confirming', async () => {
    signedInAs('bob');
    const user = userEvent.setup();
    renderWithProviders(<OrganizationSection />);

    expect(await screen.findByTestId('organization-name')).toHaveTextContent('Acme');
    expect(screen.queryByLabelText('Organization name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add avatar' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave organization' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave Acme?' });
    await user.click(within(dialog).getByRole('button', { name: 'Leave organization' }));

    await waitFor(() => expect(calls.leave).toHaveBeenCalledWith({ organizationId: 'org-acme' }));
    await waitFor(() => expect(reloadIntoOrganization).toHaveBeenCalled());
  });

  it('tells the owner they cannot leave', async () => {
    signedInAs('ada');
    renderWithProviders(<OrganizationSection />);

    expect(await screen.findByText(/stay its owner, so you cannot leave it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave organization' })).not.toBeInTheDocument();
  });

  it('tells a viewer they can only look', async () => {
    organization = {
      ...organization,
      members: [...organization.members, { id: 'm-vera', userId: 'vera', role: 'viewer', user: { id: 'vera', name: 'Vera', email: 'vera@example.com' } }],
    };
    signedInAs('vera');
    renderWithProviders(<OrganizationSection />);

    expect(await screen.findByText(/you can look at everything but change nothing/)).toBeInTheDocument();
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
    signedInAs('bob');
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
