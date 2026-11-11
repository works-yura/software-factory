import { createClient } from '@libsql/client';
import { LibsqlDialect } from '@libsql/kysely-libsql';
import { betterAuth } from 'better-auth';
import type { Auth, BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { beforeEach, describe, expect, it } from 'vitest';

import { factoryBetterAuthOptions, INVITATION_EXPIRES_IN_SECONDS, MastraAuthBetterAuth } from './index';

/**
 * The options Factory actually runs on (`factoryBetterAuthOptions`) against a
 * real libSQL database with better-auth's own migrations. Google is the
 * boundary: its ID-token check and profile lookup are replaced, everything
 * after (user/account rows, linking, sessions, organizations) is better-auth.
 */

const ORIGIN = 'http://localhost:4111';
const SECRET = 'test-secret-that-is-at-least-32-characters';

interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

let profiles: Map<string, GoogleProfile>;
let provider: MastraAuthBetterAuth;
let auth: Auth;

beforeEach(async () => {
  profiles = new Map();
  const client = createClient({ url: ':memory:' });
  const base = factoryBetterAuthOptions({
    database: {
      dialect: new LibsqlDialect({ client } as ConstructorParameters<typeof LibsqlDialect>[0]),
      type: 'sqlite',
    },
    secret: SECRET,
    google: { clientId: 'google-client', clientSecret: 'google-secret' },
    publicUrl: ORIGIN,
  });
  const options: BetterAuthOptions = {
    ...base,
    // better-auth turns its origin and callback-URL checks off under NODE_ENV=test; keep them on
    // as in production.
    advanced: { ...base.advanced, disableOriginCheck: false },
    socialProviders: {
      google: {
        ...(base.socialProviders!.google as { clientId: string; clientSecret: string; prompt: 'select_account' }),
        verifyIdToken: async token => profiles.has(token),
        getUserInfo: async tokens => {
          const profile = profiles.get(tokens.idToken ?? '');
          if (!profile) return null;
          return {
            user: { name: profile.name, email: profile.email, image: profile.picture, emailVerified: true },
            data: { ...profile, email_verified: true },
          } as never;
        },
      },
    },
  };
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  auth = betterAuth(options) as unknown as Auth;
  provider = new MastraAuthBetterAuth({ auth });
});

/** Signs in through `POST /auth/api/sign-in/social` with a Google ID token; returns the session cookie. */
async function signInWithGoogle(profile: GoogleProfile): Promise<string> {
  const idToken = `id-token-${profile.sub}`;
  profiles.set(idToken, profile);
  const response = await provider.handleAuthRequest(
    new Request(`${ORIGIN}/auth/api/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ provider: 'google', idToken: { token: idToken } }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('better-auth.session_token='));
  expect(cookie).toBeDefined();
  return cookie!.split(';')[0]!;
}

function api(path: string, cookie: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return provider.handleAuthRequest(
    new Request(`${ORIGIN}/auth/api${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { cookie, origin: ORIGIN, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    }),
  );
}

async function signedInUser(cookie: string) {
  return provider.authenticateToken('', new Request(`${ORIGIN}/api/anything`, { headers: { cookie } }));
}

async function memberRows() {
  const ctx = await auth.$context;
  return (await ctx.adapter.findMany({ model: 'member' })) as Array<{ organizationId: string; userId: string; role: string }>;
}

const ADA: GoogleProfile = { sub: 'google-ada', email: 'ada@example.com', name: 'Ada Lovelace' };
const BOB: GoogleProfile = { sub: 'google-bob', email: 'bob@example.com', name: 'Bob' };
const EVE: GoogleProfile = { sub: 'google-eve', email: 'eve@example.com', name: 'Eve' };

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
    // Why the boot migration writes moved-over users with `emailVerified: true`.
    const ctx = await auth.$context;
    await ctx.adapter.create({
      model: 'user',
      data: { id: 'unverified-row', email: 'ada@example.com', name: 'Ada', emailVerified: false, createdAt: new Date(), updatedAt: new Date() },
      forceAllowId: true,
    });
    const idToken = 'id-token-unverified';
    profiles.set(idToken, ADA);

    const response = await provider.handleAuthRequest(
      new Request(`${ORIGIN}/auth/api/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ provider: 'google', idToken: { token: idToken } }),
      }),
    );

    expect(response.ok).toBe(false);
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
