import type { Auth } from 'better-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INVITATION_EXPIRES_IN_SECONDS } from './index';
import type { MastraAuthBetterAuth } from './index';
import { createTestGoogleAuth, TEST_ORIGIN as ORIGIN } from './testing';
import type { GoogleProfile, TestGoogleAuth } from './testing';

/**
 * The options Factory actually runs on (`factoryBetterAuthOptions`) against a
 * real libSQL database with better-auth's own migrations (see `testing.ts`).
 */

let google: TestGoogleAuth;
let provider: MastraAuthBetterAuth;
let auth: Auth;

beforeEach(async () => {
  google = await createTestGoogleAuth();
  provider = google.provider;
  auth = google.auth;
});

afterEach(() => {
  vi.useRealTimers();
});

const signInWithGoogle = (profile: GoogleProfile) => google.signIn(profile);
const api = (path: string, cookie: string, init?: { method?: string; body?: unknown }) => google.api(path, cookie, init);
const memberRows = () => google.members();

async function signedInUser(cookie: string) {
  return provider.authenticateToken('', new Request(`${ORIGIN}/api/anything`, { headers: { cookie } }));
}

const ADA: GoogleProfile = { sub: 'google-ada', email: 'ada@example.com', name: 'Ada Lovelace' };
const BOB: GoogleProfile = { sub: 'google-bob', email: 'bob@example.com', name: 'Bob' };
const EVE: GoogleProfile = { sub: 'google-eve', email: 'eve@example.com', name: 'Eve' };
const CAROL: GoogleProfile = { sub: 'google-carol', email: 'carol@example.com', name: 'Carol' };

describe('Google sign-in on the Factory options', () => {
  it("hands the sign-in page Google's URL, returning to the server's callback and then the page's path", async () => {
    const response = await provider.handleAuthRequest(
      new Request(`${ORIGIN}/auth/api/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          provider: 'google',
          callbackURL: '/invite/inv-1',
          errorCallbackURL: '/signin?returnTo=%2Finvite%2Finv-1',
          disableRedirect: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const google = new URL(url);
    expect(google.origin).toBe('https://accounts.google.com');
    expect(google.searchParams.get('client_id')).toBe('google-client');
    expect(google.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/api/callback/google`);
    expect(google.searchParams.get('prompt')).toBe('select_account');
  });

  it('refuses a return address on another origin', async () => {
    const response = await provider.handleAuthRequest(
      new Request(`${ORIGIN}/auth/api/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ provider: 'google', callbackURL: 'https://evil.example/steal', disableRedirect: true }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it('signs a new person in and gives them their own organization as owner', async () => {
    const cookie = await signInWithGoogle(ADA);
    const signedIn = await signedInUser(cookie);
    expect(signedIn?.user.email).toBe('ada@example.com');

    const orgId = await provider.ensureOrganization(signedIn!.user.id);

    expect(orgId).toBeDefined();
    expect(await memberRows()).toEqual([expect.objectContaining({ organizationId: orgId, userId: signedIn!.user.id, role: 'owner' })]);
    expect(await provider.isOrganizationAdmin(orgId!, signedIn!.user.id)).toBe(true);
  });

  it('links Google to an existing user row with the same email instead of creating a new user', async () => {
    const ctx = await auth.$context;
    await ctx.adapter.create({
      model: 'user',
      data: {
        id: 'factory-local-developer',
        email: 'ada@example.com',
        name: 'Owner',
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });

    const cookie = await signInWithGoogle({ ...ADA, email: 'Ada@Example.com' });
    const signedIn = await signedInUser(cookie);

    expect(signedIn?.user.id).toBe('factory-local-developer');
    // The Google profile refreshes the moved-over row.
    expect(signedIn?.user.name).toBe('Ada Lovelace');
    expect(await ctx.adapter.count({ model: 'user' })).toBe(1);
  });

  it('does not link to an existing row whose email was never verified', async () => {
    // Why the users moved over from the previous sign-in were written with `emailVerified: true`.
    const ctx = await auth.$context;
    await ctx.adapter.create({
      model: 'user',
      data: { id: 'unverified-row', email: 'ada@example.com', name: 'Ada', emailVerified: false, createdAt: new Date(), updatedAt: new Date() },
      forceAllowId: true,
    });

    await expect(signInWithGoogle(ADA)).rejects.toThrow(/answered 4\d\d/);
    expect(await ctx.adapter.count({ model: 'account' })).toBe(0);
  });

  it('turns email/password sign-up and sign-in off', async () => {
    const signUp = await provider.handleAuthRequest(
      new Request(`${ORIGIN}/auth/api/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'mallory@example.com', password: 'super-secure-password', name: 'M' }),
      }),
    );
    expect(signUp.ok).toBe(false);
    const ctx = await auth.$context;
    expect(await ctx.adapter.count({ model: 'user' })).toBe(0);
  });

  it('does not let users create organizations through the API', async () => {
    const cookie = await signInWithGoogle(ADA);

    const response = await api('/organization/create', cookie, { body: { name: 'Side org', slug: 'side-org' } });

    expect(response.status).toBe(403);
  });
});

describe('invitation links', () => {
  async function ownerWithOrg() {
    const cookie = await signInWithGoogle(ADA);
    const owner = await signedInUser(cookie);
    const orgId = (await provider.ensureOrganization(owner!.user.id))!;
    return { cookie, orgId };
  }

  it('lets the invited email accept, makes them a member and their active organization', async () => {
    const { cookie: ownerCookie, orgId } = await ownerWithOrg();
    const invited = await api('/organization/invite-member', ownerCookie, {
      body: { email: 'bob@example.com', role: 'member', organizationId: orgId },
    });
    expect(invited.status).toBe(200);
    const invitation = (await invited.json()) as { id: string; expiresAt: string };
    const lifetimeSeconds = (new Date(invitation.expiresAt).getTime() - Date.now()) / 1000;
    expect(Math.abs(lifetimeSeconds - INVITATION_EXPIRES_IN_SECONDS)).toBeLessThan(60);

    const bobCookie = await signInWithGoogle(BOB);
    const details = await api(`/organization/get-invitation?id=${invitation.id}`, bobCookie);
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({ inviterEmail: 'ada@example.com', organizationId: orgId });

    const accepted = await api('/organization/accept-invitation', bobCookie, { body: { invitationId: invitation.id } });
    expect(accepted.status).toBe(200);

    const bob = await signedInUser(bobCookie);
    expect(bob?.session.activeOrganizationId).toBe(orgId);
    expect(await memberRows()).toContainEqual(expect.objectContaining({ organizationId: orgId, userId: bob!.user.id, role: 'member' }));
    expect(await provider.isOrganizationAdmin(orgId, bob!.user.id)).toBe(false);
  });

  it('refuses the invitation to a different email', async () => {
    const { cookie: ownerCookie, orgId } = await ownerWithOrg();
    const invited = await api('/organization/invite-member', ownerCookie, {
      body: { email: 'bob@example.com', role: 'member', organizationId: orgId },
    });
    const invitation = (await invited.json()) as { id: string };

    const eveCookie = await signInWithGoogle(EVE);
    const details = await api(`/organization/get-invitation?id=${invitation.id}`, eveCookie);
    const accepted = await api('/organization/accept-invitation', eveCookie, { body: { invitationId: invitation.id } });

    expect(details.status).toBe(403);
    expect(accepted.status).toBe(403);
    expect(await accepted.json()).toMatchObject({ code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' });
  });

  it('does not let a member invite people', async () => {
    const { cookie: ownerCookie, orgId } = await ownerWithOrg();
    const invited = await api('/organization/invite-member', ownerCookie, {
      body: { email: 'bob@example.com', role: 'member', organizationId: orgId },
    });
    const invitation = (await invited.json()) as { id: string };
    const bobCookie = await signInWithGoogle(BOB);
    await api('/organization/accept-invitation', bobCookie, { body: { invitationId: invitation.id } });

    const byMember = await api('/organization/invite-member', bobCookie, {
      body: { email: 'eve@example.com', role: 'member', organizationId: orgId },
    });

    expect(byMember.status).toBe(403);
  });

  it('takes a removed member out of the organization even though their session still names it', async () => {
    const { cookie: ownerCookie, orgId } = await ownerWithOrg();
    const invited = await api('/organization/invite-member', ownerCookie, {
      body: { email: 'bob@example.com', role: 'member', organizationId: orgId },
    });
    const invitation = (await invited.json()) as { id: string };
    const bobCookie = await signInWithGoogle(BOB);
    await api('/organization/accept-invitation', bobCookie, { body: { invitationId: invitation.id } });
    const bobMember = (await memberRows()).find(row => row.organizationId === orgId && row.role === 'member')!;

    const removed = await api('/organization/remove-member', ownerCookie, {
      body: { memberIdOrEmail: 'bob@example.com', organizationId: orgId },
    });
    expect(removed.status).toBe(200);

    const bob = await signedInUser(bobCookie);
    expect(bob?.user.id).toBe(bobMember.userId);
    expect(bob?.session.activeOrganizationId).not.toBe(orgId);
  });
});

describe('who may do what in an organization', () => {
  /** Ada owns the organization; Bob (admin) and Carol (member) joined through invitations. */
  async function organizationWithAdminAndMember() {
    const adaCookie = await signInWithGoogle(ADA);
    const ada = await signedInUser(adaCookie);
    const orgId = (await provider.ensureOrganization(ada!.user.id))!;

    async function join(profile: GoogleProfile, role: 'admin' | 'member') {
      const invited = await api('/organization/invite-member', adaCookie, {
        body: { email: profile.email, role, organizationId: orgId },
      });
      expect(invited.status).toBe(200);
      const { id } = (await invited.json()) as { id: string };
      const cookie = await signInWithGoogle(profile);
      expect((await api('/organization/accept-invitation', cookie, { body: { invitationId: id } })).status).toBe(200);
      const user = await signedInUser(cookie);
      return { cookie, userId: user!.user.id };
    }

    const bob = await join(BOB, 'admin');
    const carol = await join(CAROL, 'member');
    const members = await memberRows();
    const memberId = (userId: string) => members.find(row => row.organizationId === orgId && row.userId === userId)!.id;
    return {
      orgId,
      ada: { cookie: adaCookie, userId: ada!.user.id, memberId: memberId(ada!.user.id) },
      bob: { ...bob, memberId: memberId(bob.userId) },
      carol: { ...carol, memberId: memberId(carol.userId) },
    };
  }

  it('reports owner and admin as organization admins, a member not', async () => {
    const { orgId, ada, bob, carol } = await organizationWithAdminAndMember();

    expect(await provider.isOrganizationAdmin(orgId, ada.userId)).toBe(true);
    expect(await provider.isOrganizationAdmin(orgId, bob.userId)).toBe(true);
    expect(await provider.isOrganizationAdmin(orgId, carol.userId)).toBe(false);
  });

  it('does not let a member remove members or cancel invitations', async () => {
    const { orgId, ada, bob, carol } = await organizationWithAdminAndMember();
    const pending = await api('/organization/invite-member', ada.cookie, {
      body: { email: EVE.email, role: 'member', organizationId: orgId },
    });
    const { id: invitationId } = (await pending.json()) as { id: string };

    const remove = await api('/organization/remove-member', carol.cookie, {
      body: { memberIdOrEmail: bob.memberId, organizationId: orgId },
    });
    const cancel = await api('/organization/cancel-invitation', carol.cookie, { body: { invitationId } });

    expect(remove.ok).toBe(false);
    expect(await remove.json()).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER' });
    expect(cancel.ok).toBe(false);
    expect(await cancel.json()).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION' });
    expect((await memberRows()).filter(row => row.organizationId === orgId)).toHaveLength(3);
  });

  it('does not let an admin remove the owner', async () => {
    const { orgId, ada, bob } = await organizationWithAdminAndMember();

    const response = await api('/organization/remove-member', bob.cookie, {
      body: { memberIdOrEmail: ada.memberId, organizationId: orgId },
    });

    expect(response.ok).toBe(false);
    expect((await memberRows()).map(row => row.userId)).toContain(ada.userId);
  });

  it('lets nobody invite with the owner role, not even the owner', async () => {
    const { orgId, ada, bob } = await organizationWithAdminAndMember();

    for (const cookie of [ada.cookie, bob.cookie]) {
      const response = await api('/organization/invite-member', cookie, {
        body: { email: EVE.email, role: 'owner', organizationId: orgId },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE' });
    }
    const ctx = await auth.$context;
    expect(await ctx.adapter.count({ model: 'invitation', where: [{ field: 'email', value: EVE.email }] })).toBe(0);
  });

  it('has no role changes: update-member-role is off for everyone, the owner included', async () => {
    const { orgId, ada, bob, carol } = await organizationWithAdminAndMember();

    const attempts = [
      { cookie: ada.cookie, memberId: carol.memberId, role: 'admin' },
      { cookie: ada.cookie, memberId: bob.memberId, role: 'owner' },
      { cookie: bob.cookie, memberId: carol.memberId, role: 'admin' },
      { cookie: carol.cookie, memberId: carol.memberId, role: 'owner' },
    ];
    for (const { cookie, memberId, role } of attempts) {
      const response = await api('/organization/update-member-role', cookie, { body: { memberId, role, organizationId: orgId } });
      expect(response.status).toBe(404);
    }
    const roles = (await memberRows()).filter(row => row.organizationId === orgId).map(row => [row.userId, row.role]);
    expect(Object.fromEntries(roles)).toEqual({ [ada.userId]: 'owner', [bob.userId]: 'admin', [carol.userId]: 'member' });
  });

  it('does not let the owner leave (the organization would be left without one); others may', async () => {
    const { orgId, ada, carol } = await organizationWithAdminAndMember();

    const ownerLeaves = await api('/organization/leave', ada.cookie, { body: { organizationId: orgId } });
    const memberLeaves = await api('/organization/leave', carol.cookie, { body: { organizationId: orgId } });

    expect(ownerLeaves.status).toBe(400);
    expect(await ownerLeaves.json()).toMatchObject({ code: 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER' });
    expect(memberLeaves.status).toBe(200);
    const userIds = (await memberRows()).filter(row => row.organizationId === orgId).map(row => row.userId);
    expect(userIds).toContain(ada.userId);
    expect(userIds).not.toContain(carol.userId);
  });

  it('does not let anyone delete an organization, the owner included', async () => {
    const { orgId, ada } = await organizationWithAdminAndMember();

    const response = await api('/organization/delete', ada.cookie, { body: { organizationId: orgId } });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ORGANIZATION_DELETION_DISABLED' });
    const ctx = await auth.$context;
    expect(await ctx.adapter.findOne({ model: 'organization', where: [{ field: 'id', value: orgId }] })).not.toBeNull();
    expect((await memberRows()).filter(row => row.organizationId === orgId)).toHaveLength(3);
  });
});

describe('an expired invitation', () => {
  it('is refused after its 7 days, both when opened and when accepted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const adaCookie = await signInWithGoogle(ADA);
    const ada = await signedInUser(adaCookie);
    const orgId = (await provider.ensureOrganization(ada!.user.id))!;
    const invited = await api('/organization/invite-member', adaCookie, {
      body: { email: BOB.email, role: 'member', organizationId: orgId },
    });
    const { id } = (await invited.json()) as { id: string };

    vi.setSystemTime(Date.now() + INVITATION_EXPIRES_IN_SECONDS * 1000 + 60_000);
    const bobCookie = await signInWithGoogle(BOB);
    const details = await api(`/organization/get-invitation?id=${id}`, bobCookie);
    const accepted = await api('/organization/accept-invitation', bobCookie, { body: { invitationId: id } });

    expect(details.status).toBe(400);
    // get-invitation sends no code for a missing or expired invitation, only this message
    // (InvitePage reads a code-less 400 as "not found" for that reason).
    expect(await details.json()).toEqual({ message: 'Invitation not found!' });
    expect(accepted.status).toBe(400);
    expect(await accepted.json()).toMatchObject({ code: 'INVITATION_NOT_FOUND' });
    expect((await memberRows()).filter(row => row.organizationId === orgId)).toHaveLength(1);
  });
});
