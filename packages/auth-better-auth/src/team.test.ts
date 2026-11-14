import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MastraAuthBetterAuth } from './index';
import { emailDomainAllowed, joinLinkStatus, normalizeDomains, parseAvatarDataUrl } from './team';
import type { JoinLinkView } from './team';
import { createTestGoogleAuth, TEST_ORIGIN as ORIGIN } from './testing';
import type { GoogleProfile, TestGoogleAuth } from './testing';

/**
 * Roles, join links and avatars (ADR-0045) on the options Factory runs on,
 * against a real libSQL database with better-auth's own migrations.
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

    expect(await provider.organizationRole(orgId, ada.userId)).toBe('owner');
    expect(await provider.organizationRole(orgId, bob.userId)).toBe('admin');
    expect(await provider.organizationRole(orgId, carol.userId)).toBe('member');
    expect(await provider.organizationRole(orgId, danId)).toBe('viewer');
    expect(await provider.organizationRole('another-org', danId)).toBeNull();
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
    expect(await provider.organizationRole(orgId, carol.userId)).toBe('member');

    const response = await api('/organization/update-member-role', bob.cookie, {
      body: { memberId: carol.memberId, role: 'viewer', organizationId: orgId },
    });

    expect(response.status).toBe(200);
    expect(await roleOf(orgId, carol.userId)).toBe('viewer');
    expect(await provider.organizationRole(orgId, carol.userId)).toBe('viewer');
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

async function createLink(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return api('/factory/join-links/create', cookie, { body });
}

describe('join links', () => {
  it('lets an admin create one and lists it with its status; members cannot', async () => {
    const { orgId, bob, carol } = await team();

    const created = await createLink(bob.cookie, {
      organizationId: orgId,
      name: 'Engineering',
      role: 'viewer',
      allowedDomains: [' ACME.com ', '@research.acme.com', 'acme.com'],
      maxUses: 3,
    });
    expect(created.status).toBe(200);
    const link = (await created.json()) as JoinLinkView;
    expect(link).toMatchObject({
      name: 'Engineering',
      role: 'viewer',
      allowedDomains: ['acme.com', 'research.acme.com'],
      maxUses: 3,
      uses: 0,
      expiresAt: null,
      status: 'active',
    });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(google.events.at(-1)).toMatchObject({ action: 'factory.organization.join_link_created', targets: [{ type: 'join_link', id: link.id }] });

    const listed = await api(`/factory/join-links/list?organizationId=${orgId}`, bob.cookie);
    expect(((await listed.json()) as { joinLinks: JoinLinkView[] }).joinLinks.map(row => row.id)).toEqual([link.id]);

    expect((await createLink(carol.cookie, { organizationId: orgId, name: 'Mine', role: 'member' })).status).toBe(403);
    expect((await api(`/factory/join-links/list?organizationId=${orgId}`, carol.cookie)).status).toBe(403);
  });

  it('refuses a malformed domain, an expiry in the past and the owner role', async () => {
    const { orgId, ada } = await team();
    expect((await createLink(ada.cookie, { organizationId: orgId, name: 'x', role: 'member', allowedDomains: ['not a domain'] })).status).toBe(400);
    expect(
      (await createLink(ada.cookie, { organizationId: orgId, name: 'x', role: 'member', expiresAt: new Date(Date.now() - 1000).toISOString() })).status,
    ).toBe(400);
    expect((await createLink(ada.cookie, { organizationId: orgId, name: 'x', role: 'owner' })).status).toBe(400);
  });

  it('joins a verified email of an allowed domain with the link role, switches to the organization and audits it', async () => {
    const { orgId, ada } = await team();
    const link = (await (await createLink(ada.cookie, { organizationId: orgId, name: 'Acme', role: 'viewer', allowedDomains: ['acme.com'] })).json()) as JoinLinkView;
    const danCookie = await google.signIn(DAN);
    const danId = await userIdOf(danCookie);

    const preview = await api(`/factory/join-links/preview?token=${link.token}`, danCookie);
    expect(await preview.json()).toMatchObject({ organization: { id: orgId }, role: 'viewer', alreadyMember: false, refusal: null });

    const accepted = await api('/factory/join-links/accept', danCookie, { body: { token: link.token } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ organizationId: orgId, role: 'viewer', alreadyMember: false });
    expect(await roleOf(orgId, danId)).toBe('viewer');
    expect((await provider.authenticateToken('', new Request(`${ORIGIN}/x`, { headers: { cookie: danCookie } })))?.session.activeOrganizationId).toBe(orgId);
    expect(google.events.at(-1)).toMatchObject({ action: 'factory.organization.join_link_used', actor: { userId: danId } });

    // Again: already a member, no second use.
    const again = await api('/factory/join-links/accept', danCookie, { body: { token: link.token } });
    expect(await again.json()).toMatchObject({ alreadyMember: true });
    const listed = (await (await api(`/factory/join-links/list?organizationId=${orgId}`, ada.cookie)).json()) as { joinLinks: JoinLinkView[] };
    expect(listed.joinLinks[0]?.uses).toBe(1);
  });

  it('refuses an email outside the allowed domains', async () => {
    const { orgId, ada } = await team();
    const link = (await (await createLink(ada.cookie, { organizationId: orgId, name: 'Acme', role: 'member', allowedDomains: ['acme.com'] })).json()) as JoinLinkView;
    const eveCookie = await google.signIn({ sub: 'google-eve', email: 'eve@evil-acme.com', name: 'Eve' });

    const preview = await api(`/factory/join-links/preview?token=${link.token}`, eveCookie);
    expect(await preview.json()).toMatchObject({ refusal: 'domain_not_allowed' });
    const accepted = await api('/factory/join-links/accept', eveCookie, { body: { token: link.token } });
    expect(accepted.status).toBe(403);
    expect(await accepted.json()).toMatchObject({ code: 'JOIN_LINK_DOMAIN_NOT_ALLOWED' });
  });

  it('refuses an expired link and a revoked one', async () => {
    const { orgId, ada } = await team();
    const soon = new Date(Date.now() + 60_000).toISOString();
    const expiring = (await (await createLink(ada.cookie, { organizationId: orgId, name: 'Soon', role: 'member', expiresAt: soon })).json()) as JoinLinkView;
    const revoked = (await (await createLink(ada.cookie, { organizationId: orgId, name: 'Gone', role: 'member' })).json()) as JoinLinkView;
    expect((await api('/factory/join-links/revoke', ada.cookie, { body: { id: revoked.id } })).status).toBe(200);
    expect(google.events.at(-1)).toMatchObject({ action: 'factory.organization.join_link_revoked' });
    const danCookie = await google.signIn(DAN);

    const revokedAccept = await api('/factory/join-links/accept', danCookie, { body: { token: revoked.token } });
    expect(await revokedAccept.json()).toMatchObject({ code: 'JOIN_LINK_REVOKED' });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120_000);
    const expiredAccept = await api('/factory/join-links/accept', danCookie, { body: { token: expiring.token } });
    expect(await expiredAccept.json()).toMatchObject({ code: 'JOIN_LINK_EXPIRED' });
    expect(await roleOf(orgId, await userIdOf(danCookie))).toBeUndefined();
  });

  it('never goes past its use limit, even when people join at the same moment', async () => {
    const { orgId, ada } = await team();
    const link = (await (await createLink(ada.cookie, { organizationId: orgId, name: 'Two', role: 'member', maxUses: 2 })).json()) as JoinLinkView;
    const cookies = await Promise.all(
      Array.from({ length: 6 }, (_, index) => google.signIn({ sub: `google-p${index}`, email: `p${index}@example.com`, name: `P${index}` })),
    );

    const results = await Promise.all(cookies.map(cookie => api('/factory/join-links/accept', cookie, { body: { token: link.token } })));

    expect(results.filter(response => response.status === 200)).toHaveLength(2);
    for (const response of results.filter(response => response.status !== 200)) {
      expect(await response.json()).toMatchObject({ code: 'JOIN_LINK_USED_UP' });
    }
    const joined = (await google.members()).filter(row => row.organizationId === orgId && row.role === 'member' && row.userId !== undefined);
    // Carol (invited) plus exactly two through the link.
    expect(joined).toHaveLength(3);
    const listed = (await (await api(`/factory/join-links/list?organizationId=${orgId}`, ada.cookie)).json()) as { joinLinks: JoinLinkView[] };
    expect(listed.joinLinks[0]).toMatchObject({ uses: 2, status: 'used_up' });
  });

  it('cannot be revoked by an admin of another organization', async () => {
    const { orgId, ada } = await team();
    const link = (await (await createLink(ada.cookie, { organizationId: orgId, name: 'Acme', role: 'member' })).json()) as JoinLinkView;
    const strangerCookie = await google.signIn({ sub: 'google-stranger', email: 'stranger@example.com', name: 'S' });
    await provider.ensureOrganization(await userIdOf(strangerCookie));

    expect((await api('/factory/join-links/revoke', strangerCookie, { body: { id: link.id } })).status).toBe(403);
  });
});

describe('join link rules', () => {
  it('matches email domains exactly', () => {
    expect(emailDomainAllowed('dan@acme.com', ['acme.com'])).toBe(true);
    expect(emailDomainAllowed('dan@ACME.COM', ['acme.com'])).toBe(true);
    expect(emailDomainAllowed('dan@research.acme.com', ['acme.com'])).toBe(false);
    expect(emailDomainAllowed('dan@notacme.com', ['acme.com'])).toBe(false);
    expect(emailDomainAllowed('anyone@anywhere.io', [])).toBe(true);
  });

  it('normalizes domains and refuses malformed ones', () => {
    expect(normalizeDomains(['Acme.com', '@acme.com', ' '])).toEqual(['acme.com']);
    expect(() => normalizeDomains(['acme'])).toThrow();
    expect(() => normalizeDomains(['acme.com/path'])).toThrow();
  });

  it('reads a status: revoked before expired before used up', () => {
    const now = new Date('2026-11-15T00:00:00Z');
    const past = new Date('2026-11-14T00:00:00Z');
    expect(joinLinkStatus({ revokedAt: past, expiresAt: past, maxUses: 1, uses: 1 }, now)).toBe('revoked');
    expect(joinLinkStatus({ revokedAt: null, expiresAt: past, maxUses: 1, uses: 1 }, now)).toBe('expired');
    expect(joinLinkStatus({ revokedAt: null, expiresAt: null, maxUses: 1, uses: 1 }, now)).toBe('used_up');
    expect(joinLinkStatus({ revokedAt: null, expiresAt: null, maxUses: null, uses: 99 }, now)).toBe('active');
  });
});

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('avatars', () => {
  it('stores an uploaded image and serves it back by its id', async () => {
    const cookie = await google.signIn(ADA);
    const uploaded = await api('/factory/avatars', cookie, { body: { dataUrl: PNG_1X1 } });
    expect(uploaded.status).toBe(200);
    const { id, url } = (await uploaded.json()) as { id: string; url: string };
    expect(url).toBe(`/auth/api/factory/avatars/${id}`);

    const served = await provider.handleAuthRequest(new Request(`${ORIGIN}${url}`));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).subarray(1, 4).toString('latin1')).toBe('PNG');

    // The person's own picture.
    expect((await api('/update-user', cookie, { body: { image: url } })).status).toBe(200);
    expect((await provider.getCurrentUser(new Request(`${ORIGIN}/x`, { headers: { cookie } })))?.avatarUrl).toBe(url);
  });

  it('refuses an upload without a session', async () => {
    const response = await provider.handleAuthRequest(
      new Request(`${ORIGIN}/auth/api/factory/avatars`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ dataUrl: PNG_1X1 }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('refuses other types, content that is not the claimed image, and images over the limit', () => {
    expect(() => parseAvatarDataUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toThrow(/PNG, JPEG or WebP/);
    expect(() => parseAvatarDataUrl(`data:image/png;base64,${Buffer.from('not a png').toString('base64')}`)).toThrow(/does not match/);
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300 * 1024)]);
    expect(() => parseAvatarDataUrl(`data:image/png;base64,${big.toString('base64')}`)).toThrow(/limit is 256 KB/);
  });

  it('keeps a name and picture the person chose when they sign in with Google again', async () => {
    const cookie = await google.signIn({ ...ADA, picture: 'https://google.example/ada.png' });
    expect((await api('/update-user', cookie, { body: { name: 'Ada L.', image: '/auth/api/factory/avatars/mine' } })).status).toBe(200);

    const again = await google.signIn({ ...ADA, picture: 'https://google.example/ada-new.png' });
    const user = await provider.getCurrentUser(new Request(`${ORIGIN}/x`, { headers: { cookie: again } }));
    expect(user).toMatchObject({ name: 'Ada L.', avatarUrl: '/auth/api/factory/avatars/mine' });
  });
});
