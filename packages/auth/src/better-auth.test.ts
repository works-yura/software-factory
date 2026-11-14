import { createTestGoogleAuth } from '@factory/auth-better-auth/testing';
import type { GoogleProfile, TestGoogleAuth } from '@factory/auth-better-auth/testing';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFactoryRouteAuth, factoryAuthTenant, mountFactoryAuth } from './auth.ts';

/**
 * The Factory gate over the real Google provider (better-auth on libSQL, Google's token check
 * replaced): who is an organization admin, and how long a removed member keeps reaching `/web/*`.
 */

const ADA: GoogleProfile = { sub: 'google-ada', email: 'ada@example.com', name: 'Ada' };
const BOB: GoogleProfile = { sub: 'google-bob', email: 'bob@example.com', name: 'Bob' };
const CAROL: GoogleProfile = { sub: 'google-carol', email: 'carol@example.com', name: 'Carol' };

let google: TestGoogleAuth;
let app: Hono;

beforeEach(async () => {
  // Only the clock moves; libSQL and better-auth keep their real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  google = await createTestGoogleAuth();
  const routeAuth = createFactoryRouteAuth(google.provider);
  app = new Hono();
  mountFactoryAuth(app, { provider: google.provider });
  app.get('/web/whoami', c => c.json(factoryAuthTenant(c) ?? null));
  app.post('/web/factory/projects/:id/runs/start', c => c.json({ started: true }));
  app.get('/web/admin/:organizationId', async c =>
    c.json({ admin: await routeAuth.isOrganizationAdmin(c, c.req.param('organizationId')) }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function web(path: string, cookie: string): Promise<Response> {
  return app.request(path, { headers: { cookie, Accept: 'application/json' } });
}

async function tenant(cookie: string): Promise<{ orgId?: string; userId: string }> {
  const res = await web('/web/whoami', cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as { orgId?: string; userId: string };
}

async function isAdmin(cookie: string, organizationId: string): Promise<boolean> {
  const res = await web(`/web/admin/${organizationId}`, cookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { admin: boolean }).admin;
}

/** Ada owns her organization (created by the gate on her first request); Bob joins as admin, Carol as member. */
async function organization() {
  const ada = await google.signIn(ADA);
  const { orgId } = await tenant(ada);
  if (!orgId) throw new Error('the gate gave Ada no organization');
  async function join(profile: GoogleProfile, role: 'admin' | 'member' | 'viewer'): Promise<string> {
    const invited = await google.api('/organization/invite-member', ada, { body: { email: profile.email, role, organizationId: orgId } });
    const { id } = (await invited.json()) as { id: string };
    const cookie = await google.signIn(profile);
    expect((await google.api('/organization/accept-invitation', cookie, { body: { invitationId: id } })).status).toBe(200);
    return cookie;
  }
  return { orgId, ada, bob: await join(BOB, 'admin'), carol: await join(CAROL, 'member') };
}

describe('Factory gate on the Google provider', () => {
  it('confirms owner and admin as organization admins and denies a member', async () => {
    const { orgId, ada, bob, carol } = await organization();

    expect(await tenant(bob)).toMatchObject({ orgId });
    expect(await isAdmin(ada, orgId)).toBe(true);
    expect(await isAdmin(bob, orgId)).toBe(true);
    expect(await isAdmin(carol, orgId)).toBe(false);
  });

  it('answers 503 auth_unavailable on /web/* and /auth/me (not 401) while memberships cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ada = await google.signIn(ADA);
    await tenant(ada);
    vi.setSystemTime(Date.now() + 61_000); // past the membership cache
    const ctx = await google.auth.$context;
    const findMany = vi.spyOn(ctx.adapter, 'findMany').mockRejectedValue(new Error('database is locked'));
    const findOne = vi.spyOn(ctx.adapter, 'findOne').mockRejectedValue(new Error('database is locked'));

    const res = await web('/web/whoami', ada);
    const me = await app.request('/auth/me', { headers: { cookie: ada } });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'auth_unavailable' });
    expect(me.status).toBe(503);
    expect(await me.json()).toMatchObject({ error: 'auth_unavailable' });

    findMany.mockRestore();
    findOne.mockRestore();
    expect((await web('/web/whoami', ada)).status).toBe(200);
    error.mockRestore();
  });

  it('takes a removed member out of the organization on /web/* at once in the process that removed them', async () => {
    const { orgId, ada, carol } = await organization();
    expect(await tenant(carol)).toMatchObject({ orgId });

    const removed = await google.api('/organization/remove-member', ada, {
      body: { memberIdOrEmail: CAROL.email, organizationId: orgId },
    });
    expect(removed.status).toBe(200);

    // The removal clears this process's membership caches (ADR-0045); other replicas follow
    // within the minute their cache lasts.
    const after = await tenant(carol);
    expect(after.orgId).toBeDefined();
    expect(after.orgId).not.toBe(orgId);
    expect(await isAdmin(carol, orgId)).toBe(false);
    // Her own organization is hers to administer; Ada's stays Ada's.
    expect(await isAdmin(carol, after.orgId!)).toBe(true);
    expect(await tenant(ada)).toMatchObject({ orgId });
  });

  it('keeps a viewer read-only, and lets them write once an admin makes them a member', async () => {
    const { ada, carol, orgId } = await organization();
    const members = await google.members();
    const carolMember = members.find(row => row.organizationId === orgId && row.role === 'member')!;
    const start = (cookie: string) =>
      app.request('/web/factory/projects/p1/runs/start', { method: 'POST', headers: { cookie, Accept: 'application/json' } });

    const demoted = await google.api('/organization/update-member-role', ada, {
      body: { memberId: carolMember.id, role: 'viewer', organizationId: orgId },
    });
    expect(demoted.status).toBe(200);

    expect(await tenant(carol)).toMatchObject({ orgId, role: 'viewer' });
    const refused = await start(carol);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'viewer_read_only' });

    expect((await google.api('/organization/update-member-role', ada, { body: { memberId: carolMember.id, role: 'member', organizationId: orgId } })).status).toBe(200);
    expect((await start(carol)).status).toBe(200);
  });
});
