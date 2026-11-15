import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AssignableRole, Member, MembershipDirectory, Role } from '@factory/access';
import { enforceRouteAccess } from '@factory/http';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { AvatarsStorage, JoinLinksStorage, LocalFileBlobStore } from '@factory/store';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';

import { buildTeamRoutes } from './team.ts';
import type { TeamAuditEvent } from './team.ts';

/** An organization `org-acme` with Ada (admin); people are added by joining. */
function directory(): MembershipDirectory & { roles: Map<string, Role> } {
  const roles = new Map<string, Role>([['ada', 'admin']]);
  const emails: Record<string, string> = { ada: 'ada@acme.com', dan: 'dan@acme.com', eve: 'eve@evil.com', gus: 'gus@other.com' };
  const member = (userId: string, role: Role): Member => ({ id: `m-${userId}`, organizationId: 'org-acme', userId, role, name: userId, email: emails[userId] ?? '' });
  return {
    roles,
    role: async (organizationId, userId) => (organizationId === 'org-acme' ? (roles.get(userId) ?? null) : null),
    listMembers: async () => [...roles].map(([userId, role]) => member(userId, role)),
    addMember: async (_org, userId, role: AssignableRole) => {
      if (!roles.has(userId)) roles.set(userId, role);
      return member(userId, roles.get(userId)!);
    },
    changeRole: async () => {
      throw new Error('not used');
    },
    remove: async () => {},
    leave: async () => {},
    person: async userId => (emails[userId] ? { id: userId, email: emails[userId]!, emailVerified: true, name: userId } : null),
    organization: async id => (id === 'org-acme' ? { id, name: 'Acme', logo: null } : null),
  };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'team-routes-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const blobs = new LocalFileBlobStore({ root: join(dir, 'blobs') });
  await blobs.init();
  const backend = new LibSQLFactoryStorage({ id: 'team-routes', url: `file:${join(dir, 'db.sqlite')}` });
  const joinLinks = backend.registerDomain(new JoinLinksStorage());
  const avatars = backend.registerDomain(new AvatarsStorage(blobs));
  await backend.init();
  const people = directory();
  const audit: TeamAuditEvent[] = [];
  // The caller's organization is the one their session names: org-acme for members, their own otherwise.
  const auth = fakeRouteAuth({ role: async (_org, userId) => people.roles.get(userId) ?? 'owner' });
  const routes = enforceRouteAccess(buildTeamRoutes({ auth, joinLinks, directory: people, avatars, audit: async event => void audit.push(event) }), auth);
  const as = (userId: string) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('factoryAuthUser' as never, { id: userId, organizationId: people.roles.has(userId) ? 'org-acme' : `org-${userId}` } as never);
      await next();
    });
    mountApiRoutes(app, routes);
    return (path: string, body?: unknown) =>
      app.request(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
  return { as, people, audit };
}

describe('join link routes', () => {
  it('lets an admin create and list links; a member may not', async () => {
    const { as, people, audit } = await setup();
    people.roles.set('bob', 'member');

    const created = await as('ada')('/web/org/join-links', { name: 'Acme', role: 'viewer', allowedDomains: ['ACME.com'], maxUses: 2 });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: 'Acme', role: 'viewer', allowedDomains: ['acme.com'], maxUses: 2, status: 'active' });
    expect(audit.at(-1)).toMatchObject({ action: 'factory.organization.join_link_created', organizationId: 'org-acme', actorUserId: 'ada' });
    expect(((await (await as('ada')('/web/org/join-links')).json()) as { joinLinks: unknown[] }).joinLinks).toHaveLength(1);

    const refused = await as('bob')('/web/org/join-links', { name: 'Mine', role: 'member' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'forbidden', permission: 'join-links.manage' });
    expect((await as('bob')('/web/org/join-links')).status).toBe(403);
  });

  it('refuses a malformed link with the field it is about', async () => {
    const { as } = await setup();
    expect(await (await as('ada')('/web/org/join-links', { name: 'x', role: 'owner' })).json()).toMatchObject({ error: 'invalid_role' });
    expect(await (await as('ada')('/web/org/join-links', { name: 'x', role: 'member', allowedDomains: ['acme'] })).json()).toMatchObject({ error: 'invalid_email_domain' });
    expect(await (await as('ada')('/web/org/join-links', { name: 'x', role: 'member', maxUses: 0 })).json()).toMatchObject({ error: 'invalid_max_uses' });
    expect(await (await as('ada')('/web/org/join-links', { name: 'x', role: 'member', expiresAt: '2020-01-01T00:00:00Z' })).json()).toMatchObject({ error: 'expiry_in_the_past' });
  });

  it('joins an allowed email with the link role, once, and audits it', async () => {
    const { as, people, audit } = await setup();
    const link = (await (await as('ada')('/web/org/join-links', { name: 'Acme', role: 'viewer', allowedDomains: ['acme.com'] })).json()) as { token: string };

    expect(await (await as('dan')(`/web/join/${link.token}`)).json()).toMatchObject({ organization: { name: 'Acme' }, role: 'viewer', alreadyMember: false, refusal: null });
    const joined = await as('dan')(`/web/join/${link.token}/accept`, {});
    expect(await joined.json()).toEqual({ organizationId: 'org-acme', role: 'viewer', alreadyMember: false });
    expect(people.roles.get('dan')).toBe('viewer');
    expect(audit.at(-1)).toMatchObject({ action: 'factory.organization.join_link_used', actorUserId: 'dan' });

    expect(await (await as('dan')(`/web/join/${link.token}/accept`, {})).json()).toMatchObject({ alreadyMember: true });
  });

  it('refuses an email outside the allowed domains and a link that is used up', async () => {
    const { as } = await setup();
    const link = (await (await as('ada')('/web/org/join-links', { name: 'Acme', role: 'member', allowedDomains: ['acme.com'], maxUses: 1 })).json()) as { token: string };

    const eve = await as('eve')(`/web/join/${link.token}/accept`, {});
    expect(eve.status).toBe(403);
    expect(await eve.json()).toMatchObject({ error: 'join_link_domain_not_allowed' });
    expect((await as('dan')(`/web/join/${link.token}/accept`, {})).status).toBe(200);
    const other = (await (await as('ada')('/web/org/join-links', { name: 'Open', role: 'member', maxUses: 1 })).json()) as { token: string };
    expect((await as('eve')(`/web/join/${other.token}/accept`, {})).status).toBe(200);
    expect(await (await as('gus')(`/web/join/${other.token}/accept`, {})).json()).toMatchObject({ error: 'join_link_used_up' });
  });

  it('says a token does not exist', async () => {
    const { as } = await setup();
    expect((await as('dan')('/web/join/nope')).status).toBe(404);
  });
});

describe('avatar routes', () => {
  it('stores an uploaded image and serves it back', async () => {
    const { as } = await setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

    const uploaded = await as('ada')('/web/avatars', { dataUrl: `data:image/png;base64,${png.toString('base64')}` });
    expect(uploaded.status).toBe(201);
    const { url } = (await uploaded.json()) as { url: string };
    const served = await as('ada')(url);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer())).toEqual(png);

    expect(await (await as('ada')('/web/avatars', { dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })).json()).toMatchObject({ error: 'avatar_type' });
  });
});
