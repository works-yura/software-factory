/**
 * Join links and avatars (ADR-0045). The routes work against `@factory/access`'s interfaces: the
 * links in a `JoinLinkStore`, avatars in an `AvatarStore`, members in the auth provider's
 * `MembershipDirectory`. What each route needs is declared below; organization members, roles and
 * invitations stay on the provider's own endpoints (`/auth/api/organization/*`).
 */
import {
  AccessRuleError,
  isAssignableRole,
  JOIN_LINK_MAX_USES_LIMIT,
  JOIN_LINK_NAME_MAX,
  joinLinkStatus,
  joinRefusal,
  normalizeDomains,
  parseAvatarDataUrl,
} from '@factory/access';
import type { AvatarStore, JoinLink, JoinLinkStore, MembershipDirectory } from '@factory/access';
import { declareAccess } from '@factory/http';
import type { RouteAccess, RouteAuth } from '@factory/http';
import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

/** An organization event for the audit log. */
export interface TeamAuditEvent {
  action: 'factory.organization.join_link_created' | 'factory.organization.join_link_revoked' | 'factory.organization.join_link_used';
  organizationId: string;
  actorUserId: string;
  targets: Array<{ type: string; id: string; name?: string }>;
  metadata?: Record<string, unknown>;
}

export interface TeamRoutesDeps {
  auth: RouteAuth;
  joinLinks: JoinLinkStore;
  directory: MembershipDirectory;
  /** Absent when the server has no attachment blob store: avatar uploads answer 503 saying so. */
  avatars?: AvatarStore;
  audit: (event: TeamAuditEvent) => Promise<void>;
  now?: () => Date;
}

function linkView(link: JoinLink, now: Date) {
  return {
    ...link,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
    status: joinLinkStatus(link, now),
  };
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bad(c: Context, code: string, message: string) {
  return c.json({ error: code, message }, 400);
}

type Caller = { orgId: string; userId: string };

async function caller(c: Context, auth: RouteAuth): Promise<Caller | Response> {
  await auth.ensureUser(c);
  const tenant = auth.tenant(c);
  if (!tenant) return c.json({ error: 'unauthorized' }, 401);
  if (!tenant.orgId) return c.json({ error: 'organization_required', message: 'Join links need an organization.' }, 403);
  return { orgId: tenant.orgId, userId: tenant.userId };
}

/** Parses the create-link form: a 400 naming the field, never a silent default. */
function parseNewLink(c: Context, body: Record<string, unknown> | null) {
  if (!body) return bad(c, 'invalid_body', 'Send the join link as JSON.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > JOIN_LINK_NAME_MAX) return bad(c, 'invalid_name', `Name the link (1 to ${JOIN_LINK_NAME_MAX} characters).`);
  if (!isAssignableRole(body.role)) return bad(c, 'invalid_role', 'A join link gives viewer, member or admin.');
  const domainsInput = body.allowedDomains ?? [];
  if (!Array.isArray(domainsInput) || !domainsInput.every(domain => typeof domain === 'string')) {
    return bad(c, 'invalid_email_domain', 'Allowed domains are a list of domains.');
  }
  let allowedDomains: string[];
  try {
    allowedDomains = normalizeDomains(domainsInput as string[]);
  } catch (error) {
    if (error instanceof AccessRuleError) return bad(c, error.code, error.message);
    throw error;
  }
  let expiresAt: Date | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    expiresAt = typeof body.expiresAt === 'string' ? new Date(body.expiresAt) : new Date(Number.NaN);
    if (Number.isNaN(expiresAt.getTime())) return bad(c, 'invalid_expiry', 'The expiry is not a date.');
    if (expiresAt.getTime() <= Date.now()) return bad(c, 'expiry_in_the_past', 'The expiry must be in the future.');
  }
  let maxUses: number | null = null;
  if (body.maxUses !== undefined && body.maxUses !== null) {
    if (typeof body.maxUses !== 'number' || !Number.isInteger(body.maxUses) || body.maxUses < 1 || body.maxUses > JOIN_LINK_MAX_USES_LIMIT) {
      return bad(c, 'invalid_max_uses', `Maximum uses is a whole number from 1 to ${JOIN_LINK_MAX_USES_LIMIT}.`);
    }
    maxUses = body.maxUses;
  }
  return { name, role: body.role, allowedDomains, expiresAt, maxUses };
}

const ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  'GET /web/org/join-links': 'join-links.manage',
  'POST /web/org/join-links': 'join-links.manage',
  'POST /web/org/join-links/:id/revoke': 'join-links.manage',
  // Anyone signed in holding the link: the link is what admits them.
  'POST /web/join/:token/accept': 'self.write',
  'POST /web/avatars': 'self.write',
};

export function buildTeamRoutes(deps: TeamRoutesDeps): ApiRoute[] {
  const now = deps.now ?? (() => new Date());
  const { auth, joinLinks, directory } = deps;

  const routes: ApiRoute[] = [
    registerApiRoute('/web/org/join-links', {
      method: 'GET',
      handler: async c => {
        const who = await caller(c as unknown as Context, auth);
        if (who instanceof Response) return who;
        const at = now();
        return c.json({ joinLinks: (await joinLinks.list(who.orgId)).map(link => linkView(link, at)) });
      },
    }),
    registerApiRoute('/web/org/join-links', {
      method: 'POST',
      handler: async c => {
        const context = c as unknown as Context;
        const who = await caller(context, auth);
        if (who instanceof Response) return who;
        const parsed = parseNewLink(context, await readJson(context));
        if (parsed instanceof Response) return parsed;
        const link = await joinLinks.create({ ...parsed, organizationId: who.orgId, createdBy: who.userId });
        await deps.audit({
          action: 'factory.organization.join_link_created',
          organizationId: who.orgId,
          actorUserId: who.userId,
          targets: [{ type: 'join_link', id: link.id, name: link.name }],
          metadata: {
            role: link.role,
            allowedDomains: link.allowedDomains,
            expiresAt: link.expiresAt?.toISOString() ?? null,
            maxUses: link.maxUses,
          },
        });
        return c.json(linkView(link, now()), 201);
      },
    }),
    registerApiRoute('/web/org/join-links/:id/revoke', {
      method: 'POST',
      handler: async c => {
        const who = await caller(c as unknown as Context, auth);
        if (who instanceof Response) return who;
        const id = c.req.param('id');
        const before = await joinLinks.get(who.orgId, id);
        if (!before) return c.json({ error: 'not_found', message: 'No such join link in your organization.' }, 404);
        const link = await joinLinks.revoke(who.orgId, id, now());
        if (!link) return c.json({ error: 'not_found', message: 'No such join link in your organization.' }, 404);
        if (!before.revokedAt) {
          await deps.audit({
            action: 'factory.organization.join_link_revoked',
            organizationId: who.orgId,
            actorUserId: who.userId,
            targets: [{ type: 'join_link', id: link.id, name: link.name }],
          });
        }
        return c.json(linkView(link, now()));
      },
    }),
    registerApiRoute('/web/join/:token', {
      method: 'GET',
      handler: async c => {
        await auth.ensureUser(c as unknown as Context);
        const tenant = auth.tenant(c as unknown as Context);
        if (!tenant) return c.json({ error: 'unauthorized' }, 401);
        const link = await joinLinks.findByToken(c.req.param('token'));
        if (!link) return c.json({ error: 'join_link_not_found', message: 'This join link does not exist.' }, 404);
        const person = await directory.person(tenant.userId);
        if (!person) return c.json({ error: 'unauthorized' }, 401);
        const organization = await directory.organization(link.organizationId);
        if (!organization) return c.json({ error: 'join_link_not_found', message: 'The organization of this link is gone.' }, 404);
        return c.json({
          organization,
          role: link.role,
          name: link.name,
          alreadyMember: (await directory.role(link.organizationId, tenant.userId)) !== null,
          refusal: joinRefusal(link, person, now()),
        });
      },
    }),
    registerApiRoute('/web/join/:token/accept', {
      method: 'POST',
      handler: async c => {
        await auth.ensureUser(c as unknown as Context);
        const tenant = auth.tenant(c as unknown as Context);
        if (!tenant) return c.json({ error: 'unauthorized' }, 401);
        const link = await joinLinks.findByToken(c.req.param('token'));
        if (!link) return c.json({ error: 'join_link_not_found', message: 'This join link does not exist.' }, 404);
        const existing = await directory.role(link.organizationId, tenant.userId);
        if (existing) return c.json({ organizationId: link.organizationId, role: existing, alreadyMember: true });
        const person = await directory.person(tenant.userId);
        if (!person) return c.json({ error: 'unauthorized' }, 401);
        const refusal = joinRefusal(link, person, now());
        if (refusal) return c.json({ error: `join_link_${refusal}`, refusal }, 403);
        // Counted under a row lock: concurrent joins never pass the limit.
        const used = await joinLinks.takeUse(link.id, now());
        if ('refusal' in used) return c.json({ error: `join_link_${used.refusal}`, refusal: used.refusal }, 403);
        const member = await directory.addMember(link.organizationId, tenant.userId, link.role);
        await deps.audit({
          action: 'factory.organization.join_link_used',
          organizationId: link.organizationId,
          actorUserId: tenant.userId,
          targets: [
            { type: 'join_link', id: link.id, name: link.name },
            { type: 'member', id: tenant.userId, name: person.email },
          ],
          metadata: { role: member.role },
        });
        return c.json({ organizationId: link.organizationId, role: member.role, alreadyMember: false });
      },
    }),
    registerApiRoute('/web/avatars', {
      method: 'POST',
      handler: async c => {
        const context = c as unknown as Context;
        await auth.ensureUser(context);
        const tenant = auth.tenant(context);
        if (!tenant) return c.json({ error: 'unauthorized' }, 401);
        if (!deps.avatars) {
          return c.json(
            { error: 'avatars_unavailable', message: 'This server has no attachment store, so it cannot keep avatars.' },
            503,
          );
        }
        const body = await readJson(context);
        if (!body || typeof body.dataUrl !== 'string') return bad(context, 'invalid_avatar', 'Send the avatar as a data URL.');
        let avatar: ReturnType<typeof parseAvatarDataUrl>;
        try {
          avatar = parseAvatarDataUrl(body.dataUrl);
        } catch (error) {
          if (error instanceof AccessRuleError) return bad(context, error.code, error.message);
          throw error;
        }
        const { id } = await deps.avatars.put(tenant.userId, avatar.type, avatar.bytes);
        return c.json({ id, url: `/web/avatars/${id}` }, 201);
      },
    }),
    registerApiRoute('/web/avatars/:id', {
      method: 'GET',
      handler: async c => {
        if (!deps.avatars) return c.json({ error: 'not_found' }, 404);
        const avatar = await deps.avatars.get(c.req.param('id'));
        if (!avatar) return c.json({ error: 'not_found' }, 404);
        return new Response(Buffer.from(avatar.bytes), {
          headers: {
            'Content-Type': avatar.type,
            // A picture never changes: a new one is a new id.
            'Cache-Control': 'private, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      },
    }),
  ];
  return declareAccess(routes, ROUTE_ACCESS);
}
