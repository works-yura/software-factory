import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InvitationCreated, InvitationNotifier } from '@factory/access';

import type { MastraAuthBetterAuth } from './index';
import { createTestGoogleAuth, TEST_ORIGIN as ORIGIN } from './testing';
import type { GoogleProfile, TestGoogleAuth } from './testing';

/**
 * Roles (ADR-0045) on the options Factory runs on, and the provider as the membership directory and
 * invitation service of `@factory/access`, against a real libSQL database with better-auth's own
 * migrations.
 */

let google: TestGoogleAuth;
let provider: MastraAuthBetterAuth;

beforeEach(async () => {
  google = await createTestGoogleAuth();
  provider = google.provider;
});

afterEach(() => {
  vi.useRealTimers();
});

const api = (path: string, cookie: string, init?: { method?: string; body?: unknown }) => google.api(path, cookie, init);

async function userIdOf(cookie: string): Promise<string> {
  const user = await provider.authenticateToken('', new Request(`${ORIGIN}/api/anything`, { headers: { cookie } }));
  return user!.user.id;
}

const ADA: GoogleProfile = { sub: 'google-ada', email: 'ada@example.com', name: 'Ada Lovelace' };
const BOB: GoogleProfile = { sub: 'google-bob', email: 'bob@example.com', name: 'Bob' };
const CAROL: GoogleProfile = { sub: 'google-carol', email: 'carol@example.com', name: 'Carol' };
const DAN: GoogleProfile = { sub: 'google-dan', email: 'dan@acme.com', name: 'Dan' };

/** Ada owns the organization; Bob (admin) and Carol (member) joined through invitations. */
async function team() {
  const adaCookie = await google.signIn(ADA);
  const adaId = await userIdOf(adaCookie);
  const orgId = (await provider.ensureOrganization(adaId))!;

  async function join(profile: GoogleProfile, role: 'admin' | 'member' | 'viewer') {
    const invited = await api('/organization/invite-member', adaCookie, {
      body: { email: profile.email, role, organizationId: orgId },
    });
    expect(invited.status).toBe(200);
    const { id } = (await invited.json()) as { id: string };
    const cookie = await google.signIn(profile);
    expect((await api('/organization/accept-invitation', cookie, { body: { invitationId: id } })).status).toBe(200);
    return { cookie, userId: await userIdOf(cookie) };
  }

  const bob = await join(BOB, 'admin');
  const carol = await join(CAROL, 'member');
  const members = await google.members();
  const memberId = (userId: string) => members.find(row => row.organizationId === orgId && row.userId === userId)!.id;
  return {
    orgId,
    ada: { cookie: adaCookie, userId: adaId, memberId: memberId(adaId) },
    bob: { ...bob, memberId: memberId(bob.userId) },
    carol: { ...carol, memberId: memberId(carol.userId) },
  };
}

async function roleOf(orgId: string, userId: string): Promise<string | undefined> {
  return (await google.members()).find(row => row.organizationId === orgId && row.userId === userId)?.role;
}

describe('roles', () => {
  it('invites a viewer, and reports each role', async () => {
    const { orgId, ada, bob, carol } = await team();
    const invited = await api('/organization/invite-member', ada.cookie, {
      body: { email: DAN.email, role: 'viewer', organizationId: orgId },
    });
    expect(invited.status).toBe(200);
    const { id } = (await invited.json()) as { id: string };
    const danCookie = await google.signIn(DAN);
    expect((await api('/organization/accept-invitation', danCookie, { body: { invitationId: id } })).status).toBe(200);
    const danId = await userIdOf(danCookie);

    expect(await provider.role(orgId, ada.userId)).toBe('owner');
    expect(await provider.role(orgId, bob.userId)).toBe('admin');
    expect(await provider.role(orgId, carol.userId)).toBe('member');
    expect(await provider.role(orgId, danId)).toBe('viewer');
    expect(await provider.role('another-org', danId)).toBeNull();
    expect(await provider.isOrganizationAdmin(orgId, danId)).toBe(false);
  });

  it('refuses invitations with a role outside viewer, member and admin', async () => {
    const { orgId, ada } = await team();
    for (const role of ['owner', 'superuser', 'member,admin']) {
      const response = await api('/organization/invite-member', ada.cookie, {
        body: { email: DAN.email, role, organizationId: orgId },
      });
      expect(response.ok).toBe(false);
    }
  });

  it('lets an admin change a role among viewer, member and admin, audited, and the role cache follows at once', async () => {
    const { orgId, bob, carol } = await team();
    expect(await provider.role(orgId, carol.userId)).toBe('member');

    const response = await api('/organization/update-member-role', bob.cookie, {
      body: { memberId: carol.memberId, role: 'viewer', organizationId: orgId },
    });

    expect(response.status).toBe(200);
    expect(await roleOf(orgId, carol.userId)).toBe('viewer');
    expect(await provider.role(orgId, carol.userId)).toBe('viewer');
    expect(google.events.at(-1)).toMatchObject({
      action: 'factory.organization.member_role_changed',
      organizationId: orgId,
      actor: { userId: bob.userId, email: BOB.email },
      targets: [{ type: 'member', id: carol.userId }],
      metadata: { role: 'viewer' },
    });
  });

  it('never touches the owner and never hands out owner, not even by the owner', async () => {
    const { orgId, ada, bob, carol } = await team();
    const attempts = [
      { cookie: bob.cookie, memberId: ada.memberId, role: 'member' },
      { cookie: ada.cookie, memberId: ada.memberId, role: 'admin' },
      { cookie: ada.cookie, memberId: bob.memberId, role: 'owner' },
      { cookie: ada.cookie, memberId: carol.memberId, role: 'superuser' },
    ];
    for (const { cookie, memberId, role } of attempts) {
      const response = await api('/organization/update-member-role', cookie, { body: { memberId, role, organizationId: orgId } });
      expect(response.ok).toBe(false);
    }
    expect(await roleOf(orgId, ada.userId)).toBe('owner');
    expect(await roleOf(orgId, bob.userId)).toBe('admin');
    expect(await roleOf(orgId, carol.userId)).toBe('member');
  });

  it('does not let a member or a viewer change roles', async () => {
    const { orgId, bob, carol } = await team();
    const response = await api('/organization/update-member-role', carol.cookie, {
      body: { memberId: bob.memberId, role: 'viewer', organizationId: orgId },
    });
    expect(response.ok).toBe(false);
    expect(await roleOf(orgId, bob.userId)).toBe('admin');
  });

  it('audits removals and organization edits', async () => {
    const { orgId, ada, carol } = await team();
    expect((await api('/organization/remove-member', ada.cookie, { body: { memberIdOrEmail: carol.memberId, organizationId: orgId } })).status).toBe(200);
    expect((await api('/organization/update', ada.cookie, { body: { organizationId: orgId, data: { name: 'Works' } } })).status).toBe(200);

    expect(google.events.map(event => event.action)).toEqual(
      expect.arrayContaining(['factory.organization.member_removed', 'factory.organization.updated']),
    );
    expect(google.events.find(event => event.action === 'factory.organization.updated')).toMatchObject({
      targets: [{ type: 'organization', id: orgId, name: 'Works' }],
      metadata: { fields: ['name'] },
    });
  });

  it('does not let a member rename the organization', async () => {
    const { orgId, carol } = await team();
    const response = await api('/organization/update', carol.cookie, { body: { organizationId: orgId, data: { name: 'Mine' } } });
    expect(response.ok).toBe(false);
  });
});

describe('the membership directory and invitations (adapter for @factory/access)', () => {
  it('lists members with their profiles and roles', async () => {
    const { orgId, ada, bob, carol } = await team();

    const members = await provider.listMembers(orgId);

    expect(members.map(member => [member.userId, member.role, member.email])).toEqual([
      [ada.userId, 'owner', ADA.email],
      [bob.userId, 'admin', BOB.email],
      [carol.userId, 'member', CAROL.email],
    ]);
  });

  it('adds a member once (a join), and the role cache follows at once', async () => {
    const { orgId } = await team();
    const danId = await userIdOf(await google.signIn(DAN));
    expect(await provider.role(orgId, danId)).toBeNull();

    const added = await provider.addMember(orgId, danId, 'viewer');
    const again = await provider.addMember(orgId, danId, 'admin');

    expect(added).toMatchObject({ organizationId: orgId, userId: danId, role: 'viewer', email: DAN.email });
    expect(again.id).toBe(added.id);
    expect(again.role).toBe('viewer');
    expect(await provider.role(orgId, danId)).toBe('viewer');
  });

  it('changes roles and removes members, never the owner', async () => {
    const { orgId, ada, carol } = await team();

    expect(await provider.changeRole(orgId, carol.memberId, 'viewer')).toMatchObject({ role: 'viewer' });
    expect(await provider.role(orgId, carol.userId)).toBe('viewer');
    await expect(provider.changeRole(orgId, ada.memberId, 'member')).rejects.toThrow(/owner keeps/);
    await expect(provider.changeRole(orgId, carol.memberId, 'owner' as never)).rejects.toThrow(/Cannot give/);
    await expect(provider.remove(orgId, ada.memberId)).rejects.toThrow(/owner cannot be removed/);

    await provider.remove(orgId, carol.memberId);
    expect(await provider.role(orgId, carol.userId)).toBeNull();
  });

  it('lets a member leave but not the owner', async () => {
    const { orgId, ada, bob } = await team();

    await provider.leave(orgId, bob.userId);

    expect(await provider.role(orgId, bob.userId)).toBeNull();
    await expect(provider.leave(orgId, ada.userId)).rejects.toThrow(/owner cannot leave/);
  });

  it('reads a person with whether their email is verified', async () => {
    const { ada } = await team();
    expect(await provider.person(ada.userId)).toMatchObject({ id: ada.userId, email: ADA.email, emailVerified: true });
    expect(await provider.person('nobody')).toBeNull();
  });

  it('invites with a role, lists and cancels invitations', async () => {
    const { orgId, ada } = await team();

    const invitation = await provider.invite(orgId, ' Dan@Acme.com ', 'viewer', ada.userId);
    expect(invitation).toMatchObject({ organizationId: orgId, email: 'dan@acme.com', role: 'viewer', status: 'pending' });
    await provider.cancel(orgId, invitation.id);

    expect((await provider.list(orgId)).find(row => row.id === invitation.id)?.status).toBe('canceled');
  });

  it('refuses a stored role it does not know instead of guessing', async () => {
    const { orgId, carol } = await team();
    const ctx = await google.auth.$context;
    await ctx.adapter.update({ model: 'member', where: [{ field: 'id', value: carol.memberId }], update: { role: 'superuser' } });

    await expect(provider.role(orgId, carol.userId)).rejects.toThrow(/unknown role "superuser"/);
  });
});

describe('invitation notices (InvitationNotifier)', () => {
  async function owner(invitations: InvitationNotifier) {
    google = await createTestGoogleAuth({ invitations });
    provider = google.provider;
    const cookie = await google.signIn(ADA);
    const orgId = (await provider.ensureOrganization(await userIdOf(cookie)))!;
    return { cookie, orgId };
  }

  it('tells the notifier about each invitation and each resend, with the organization and the inviter', async () => {
    const sent: InvitationCreated[] = [];
    const { cookie, orgId } = await owner({ invitationCreated: async event => void sent.push(event) });

    const invited = await api('/organization/invite-member', cookie, { body: { email: 'Bob@Example.com', role: 'member', organizationId: orgId } });
    expect(invited.status).toBe(200);
    const { id } = (await invited.json()) as { id: string };
    const resent = await api('/organization/invite-member', cookie, {
      body: { email: BOB.email, role: 'member', organizationId: orgId, resend: true },
    });
    expect(resent.status).toBe(200);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      invitationId: id,
      email: 'bob@example.com',
      role: 'member',
      organization: { id: orgId },
      inviter: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    expect(sent[0]!.organization.name).toBeTruthy();
    expect(sent[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(sent[1]!.invitationId).toBe(id);
  });

  it('keeps the invitation when the notifier throws', async () => {
    const { cookie, orgId } = await owner({ invitationCreated: async () => Promise.reject(new Error('smtp down')) });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const invited = await api('/organization/invite-member', cookie, { body: { email: BOB.email, role: 'member', organizationId: orgId } });

    expect(invited.status).toBe(200);
    expect(await provider.list(orgId)).toHaveLength(1);
    quiet.mockRestore();
  });
});

describe('profile', () => {
  it('keeps a name and picture the person chose when they sign in with Google again', async () => {
    const cookie = await google.signIn({ ...ADA, picture: 'https://google.example/ada.png' });
    expect((await api('/update-user', cookie, { body: { name: 'Ada L.', image: '/web/avatars/mine' } })).status).toBe(200);

    const again = await google.signIn({ ...ADA, picture: 'https://google.example/ada-new.png' });
    const user = await provider.getCurrentUser(new Request(`${ORIGIN}/x`, { headers: { cookie: again } }));
    expect(user).toMatchObject({ name: 'Ada L.', avatarUrl: '/web/avatars/mine' });
  });
});
