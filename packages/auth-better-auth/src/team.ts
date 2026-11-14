/**
 * Factory's team additions on better-auth (ADR-0045): the `viewer` role, the
 * events the server audits, join links (an organization's shareable link with a
 * role, allowed email domains, an expiry and a use limit) and uploaded avatars.
 *
 * Join links and avatars live in two tables of their own (`join_links`,
 * `factory_avatars`) that better-auth's migrations create next to its own; no
 * existing table changes.
 */
import { randomBytes } from 'node:crypto';

import type { AuthContext, BetterAuthPlugin, Session, User } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, sessionMiddleware } from 'better-auth/api';
import { defaultAc, defaultRoles } from 'better-auth/plugins/organization/access';
import * as z from 'zod';

/** The organization plugin's creator role: one per organization, never given. */
export const OWNER_ROLE = 'owner';

/** Roles a person can be given: by an invitation, a join link or a role change. */
export const ASSIGNABLE_ROLES = ['viewer', 'member', 'admin'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(role: string): role is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(role);
}

/** Admin-equivalent roles: they manage members, roles, invitations and join links. */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === OWNER_ROLE || role === 'admin';
}

/**
 * Access control for the organization plugin: better-auth's own roles plus
 * `viewer`, which holds no organization permission (like `member`); what keeps a
 * viewer read-only in Factory is the server's gate, not better-auth.
 */
export const organizationAccessControl = {
  ac: defaultAc,
  roles: {
    ...defaultRoles,
    viewer: defaultAc.newRole({ organization: [], member: [], invitation: [], team: [], ac: ['read'] }),
  },
};

// ============================================
// Events
// ============================================

/** Something that happened to an organization, for the server's audit log. */
export interface OrganizationEvent {
  action:
    | 'factory.organization.updated'
    | 'factory.organization.member_role_changed'
    | 'factory.organization.member_removed'
    | 'factory.organization.member_left'
    | 'factory.organization.invitation_created'
    | 'factory.organization.invitation_canceled'
    | 'factory.organization.invitation_accepted'
    | 'factory.organization.join_link_created'
    | 'factory.organization.join_link_revoked'
    | 'factory.organization.join_link_used';
  organizationId: string;
  actor: { userId: string; name?: string; email?: string; avatarUrl?: string };
  targets: Array<{ type: string; id: string; name?: string }>;
  metadata?: Record<string, unknown>;
}

export type OrganizationEventHandler = (event: OrganizationEvent) => Promise<void>;

/**
 * Carries organization events from better-auth to whoever records them (the
 * Factory server's audit log), and membership changes to the provider's role
 * cache. The handler is set after construction because the audit log exists
 * only once the server has booted.
 */
export class OrganizationEventRelay {
  #handler: OrganizationEventHandler | undefined;
  #membershipListeners = new Set<(organizationId: string, userId: string) => void>();

  setHandler(handler: OrganizationEventHandler | undefined): void {
    this.#handler = handler;
  }

  onMembershipChanged(listener: (organizationId: string, userId: string) => void): void {
    this.#membershipListeners.add(listener);
  }

  membershipChanged(organizationId: string, userId: string): void {
    for (const listener of this.#membershipListeners) listener(organizationId, userId);
  }

  /**
   * Records the event. The change it describes already happened, so a missing
   * handler or a failed write is logged loudly but does not undo or fail it.
   */
  async emit(event: OrganizationEvent): Promise<void> {
    const handler = this.#handler;
    if (!handler) {
      console.error(
        `[BetterAuth] Organization event ${event.action} in ${event.organizationId} was not audited: no audit handler is set.`,
      );
      return;
    }
    try {
      await handler(event);
    } catch (error) {
      console.error(`[BetterAuth] Could not audit organization event ${event.action} in ${event.organizationId}.`, error);
    }
  }
}

function actorOf(user: User): OrganizationEvent['actor'] {
  return {
    userId: user.id,
    ...(user.name ? { name: user.name } : {}),
    ...(user.email ? { email: user.email } : {}),
    ...(user.image ? { avatarUrl: user.image } : {}),
  };
}

interface MemberLike {
  id?: string;
  userId?: string;
  organizationId?: string;
  role?: string;
}

interface InvitationLike {
  id?: string;
  email?: string;
  role?: string;
  organizationId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * better-auth's `after` hook for the organization endpoints Factory audits. It
 * reads what the endpoint returned (a failed endpoint returns an `APIError`,
 * which is skipped) and the session of whoever called it.
 */
export function organizationEventsHook(relay: OrganizationEventRelay) {
  return createAuthMiddleware(async ctx => {
    const path = ctx.path;
    if (!path.startsWith('/organization/')) return;
    const returned = ctx.context.returned;
    if (!returned || returned instanceof APIError || returned instanceof Response) return;
    const result = record(returned);
    if (!result) return;
    const session = (ctx.context.session ?? (await getSessionFromCtx(ctx))) as { user: User; session: Session } | null;
    if (!session) return;
    const actor = actorOf(session.user);
    const body = record(ctx.body) ?? {};

    switch (path) {
      case '/organization/update-member-role': {
        const member = result as MemberLike;
        if (!member.organizationId || !member.userId) return;
        relay.membershipChanged(member.organizationId, member.userId);
        await relay.emit({
          action: 'factory.organization.member_role_changed',
          organizationId: member.organizationId,
          actor,
          targets: [{ type: 'member', id: member.userId }],
          metadata: { role: member.role },
        });
        return;
      }
      case '/organization/remove-member': {
        const member = record(result.member) as MemberLike | undefined;
        if (!member?.organizationId || !member.userId) return;
        relay.membershipChanged(member.organizationId, member.userId);
        await relay.emit({
          action: 'factory.organization.member_removed',
          organizationId: member.organizationId,
          actor,
          targets: [{ type: 'member', id: member.userId }],
          metadata: { role: member.role },
        });
        return;
      }
      case '/organization/leave': {
        const member = result as MemberLike;
        if (!member.organizationId || !member.userId) return;
        relay.membershipChanged(member.organizationId, member.userId);
        await relay.emit({
          action: 'factory.organization.member_left',
          organizationId: member.organizationId,
          actor,
          targets: [{ type: 'member', id: member.userId }],
        });
        return;
      }
      case '/organization/invite-member': {
        const invitation = result as InvitationLike;
        if (!invitation.organizationId || !invitation.id) return;
        await relay.emit({
          action: 'factory.organization.invitation_created',
          organizationId: invitation.organizationId,
          actor,
          targets: [{ type: 'invitation', id: invitation.id, ...(invitation.email ? { name: invitation.email } : {}) }],
          metadata: { role: invitation.role },
        });
        return;
      }
      case '/organization/cancel-invitation': {
        const invitation = result as InvitationLike;
        if (!invitation.organizationId || !invitation.id) return;
        await relay.emit({
          action: 'factory.organization.invitation_canceled',
          organizationId: invitation.organizationId,
          actor,
          targets: [{ type: 'invitation', id: invitation.id, ...(invitation.email ? { name: invitation.email } : {}) }],
        });
        return;
      }
      case '/organization/accept-invitation': {
        const invitation = record(result.invitation) as InvitationLike | undefined;
        const member = record(result.member) as MemberLike | undefined;
        if (!invitation?.organizationId || !invitation.id) return;
        if (member?.userId) relay.membershipChanged(invitation.organizationId, member.userId);
        await relay.emit({
          action: 'factory.organization.invitation_accepted',
          organizationId: invitation.organizationId,
          actor,
          targets: [{ type: 'invitation', id: invitation.id }],
          metadata: { role: invitation.role },
        });
        return;
      }
      case '/organization/update': {
        const organization = result as { id?: string; name?: string };
        if (!organization.id) return;
        const data = record(body.data) ?? {};
        await relay.emit({
          action: 'factory.organization.updated',
          organizationId: organization.id,
          actor,
          targets: [{ type: 'organization', id: organization.id, ...(organization.name ? { name: organization.name } : {}) }],
          metadata: { fields: Object.keys(data).sort() },
        });
        return;
      }
      default:
        return;
    }
  });
}

// ============================================
// Join links and avatars
// ============================================

/** Longest a join link may be named. */
const JOIN_LINK_NAME_MAX = 80;
/** Most domains one join link may allow. */
const JOIN_LINK_DOMAINS_MAX = 20;
/** Highest use limit a join link may have. */
export const JOIN_LINK_MAX_USES_LIMIT = 10_000;
/** How many times an accept retries its conditional use increment when others win the race. */
const USE_INCREMENT_ATTEMPTS = 50;

/** Largest uploaded avatar, in bytes (after the browser's resize to 256 px). */
export const AVATAR_MAX_BYTES = 256 * 1024;
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface JoinLinkRow {
  id: string;
  organizationId: string;
  token: string;
  name: string;
  role: string;
  /** JSON array of lowercase domains; `[]` lets any verified email in. */
  allowedDomains: string;
  expiresAt: Date | null;
  maxUses: number | null;
  uses: number;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export type JoinLinkStatus = 'active' | 'expired' | 'revoked' | 'used_up';

export interface JoinLinkView {
  id: string;
  organizationId: string;
  token: string;
  name: string;
  role: AssignableRole;
  allowedDomains: string[];
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  status: JoinLinkStatus;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDomains(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((domain): domain is string => typeof domain === 'string') : [];
  } catch {
    return [];
  }
}

export function joinLinkStatus(row: Pick<JoinLinkRow, 'revokedAt' | 'expiresAt' | 'maxUses' | 'uses'>, now = new Date()): JoinLinkStatus {
  if (toDate(row.revokedAt)) return 'revoked';
  const expiresAt = toDate(row.expiresAt);
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return 'expired';
  if (row.maxUses !== null && row.maxUses !== undefined && Number(row.uses) >= Number(row.maxUses)) return 'used_up';
  return 'active';
}

function viewOf(row: JoinLinkRow): JoinLinkView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    token: row.token,
    name: row.name,
    role: isAssignableRole(row.role) ? row.role : 'member',
    allowedDomains: parseDomains(row.allowedDomains),
    expiresAt: toDate(row.expiresAt)?.toISOString() ?? null,
    maxUses: row.maxUses === null || row.maxUses === undefined ? null : Number(row.maxUses),
    uses: Number(row.uses),
    createdBy: row.createdBy,
    createdAt: (toDate(row.createdAt) ?? new Date(0)).toISOString(),
    revokedAt: toDate(row.revokedAt)?.toISOString() ?? null,
    status: joinLinkStatus(row),
  };
}

/** Lowercase, trimmed, deduplicated; a malformed domain is refused, never dropped. */
export function normalizeDomains(domains: readonly string[]): string[] {
  const normalized = [...new Set(domains.map(domain => domain.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  const invalid = normalized.filter(domain => !DOMAIN_PATTERN.test(domain));
  if (invalid.length > 0) {
    throw APIError.from('BAD_REQUEST', { code: 'INVALID_EMAIL_DOMAIN', message: `Not an email domain: ${invalid.join(', ')}` });
  }
  if (normalized.length > JOIN_LINK_DOMAINS_MAX) {
    throw APIError.from('BAD_REQUEST', {
      code: 'TOO_MANY_EMAIL_DOMAINS',
      message: `A join link allows at most ${JOIN_LINK_DOMAINS_MAX} domains.`,
    });
  }
  return normalized;
}

/** Whether the email's domain is one the link allows (exact match; an empty list allows any). */
export function emailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  return allowedDomains.includes(domain);
}

interface MemberRow {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  logo?: string | null;
}

/** The part of an endpoint's context the helpers below read. */
type EndpointContext = { context: Pick<AuthContext, 'adapter'> };

async function memberOf(ctx: EndpointContext, organizationId: string, userId: string): Promise<MemberRow | null> {
  return ctx.context.adapter.findOne<MemberRow>({
    model: 'member',
    where: [
      { field: 'organizationId', value: organizationId },
      { field: 'userId', value: userId },
    ],
  });
}

async function requireAdmin(ctx: EndpointContext, organizationId: string, userId: string): Promise<MemberRow> {
  const member = await memberOf(ctx, organizationId, userId);
  if (!member) throw APIError.from('FORBIDDEN', { code: 'NOT_A_MEMBER', message: 'You are not a member of this organization.' });
  if (!isAdminRole(member.role)) {
    throw APIError.from('FORBIDDEN', { code: 'ADMIN_REQUIRED', message: 'Only admins manage join links.' });
  }
  return member;
}

async function findLinkByToken(ctx: EndpointContext, token: string): Promise<JoinLinkRow | null> {
  return ctx.context.adapter.findOne<JoinLinkRow>({ model: 'joinLink', where: [{ field: 'token', value: token }] });
}

function sessionOf(ctx: { context: { session?: unknown } }): { user: User; session: Session } {
  return ctx.context.session as unknown as { user: User; session: Session };
}

const createJoinLinkBody = z.object({
  organizationId: z.string().min(1),
  name: z.string().trim().min(1).max(JOIN_LINK_NAME_MAX),
  role: z.enum(ASSIGNABLE_ROLES),
  allowedDomains: z.array(z.string()).default([]),
  /** ISO date-time; null or absent never expires. */
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  maxUses: z.number().int().min(1).max(JOIN_LINK_MAX_USES_LIMIT).nullable().optional(),
});

/** Why a join link cannot be used right now, for the person holding it. */
export type JoinRefusal = 'expired' | 'revoked' | 'used_up' | 'domain_not_allowed' | 'email_not_verified';

/**
 * The plugin: join links under `/factory/join-links/*` and avatars under
 * `/factory/avatars`, both behind better-auth's own session.
 */
export function factoryTeam(relay: OrganizationEventRelay): BetterAuthPlugin {
  return {
    id: 'factory-team',
    schema: {
      joinLink: {
        modelName: 'join_links',
        fields: {
          organizationId: { type: 'string', required: true, references: { model: 'organization', field: 'id', onDelete: 'cascade' } },
          token: { type: 'string', required: true, unique: true },
          name: { type: 'string', required: true },
          role: { type: 'string', required: true },
          allowedDomains: { type: 'string', required: true },
          expiresAt: { type: 'date', required: false },
          maxUses: { type: 'number', required: false },
          uses: { type: 'number', required: true, defaultValue: 0 },
          createdBy: { type: 'string', required: true },
          createdAt: { type: 'date', required: true },
          revokedAt: { type: 'date', required: false },
        },
      },
      factoryAvatar: {
        modelName: 'factory_avatars',
        fields: {
          ownerUserId: { type: 'string', required: true },
          mimeType: { type: 'string', required: true },
          /** The image, base64. */
          data: { type: 'string', required: true },
          createdAt: { type: 'date', required: true },
        },
      },
    },
    endpoints: {
      createJoinLink: createAuthEndpoint(
        '/factory/join-links/create',
        { method: 'POST', body: createJoinLinkBody, use: [sessionMiddleware], requireHeaders: true },
        async ctx => {
          const { user } = sessionOf(ctx);
          const body = ctx.body;
          await requireAdmin(ctx, body.organizationId, user.id);
          const allowedDomains = normalizeDomains(body.allowedDomains);
          const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
          if (expiresAt && expiresAt.getTime() <= Date.now()) {
            throw APIError.from('BAD_REQUEST', { code: 'EXPIRY_IN_THE_PAST', message: 'The expiry must be in the future.' });
          }
          const row = await ctx.context.adapter.create<Omit<JoinLinkRow, 'id'>, JoinLinkRow>({
            model: 'joinLink',
            data: {
              organizationId: body.organizationId,
              token: randomBytes(32).toString('base64url'),
              name: body.name,
              role: body.role,
              allowedDomains: JSON.stringify(allowedDomains),
              expiresAt,
              maxUses: body.maxUses ?? null,
              uses: 0,
              createdBy: user.id,
              createdAt: new Date(),
              revokedAt: null,
            },
          });
          await relay.emit({
            action: 'factory.organization.join_link_created',
            organizationId: body.organizationId,
            actor: actorOf(user),
            targets: [{ type: 'join_link', id: row.id, name: row.name }],
            metadata: { role: row.role, allowedDomains, expiresAt: expiresAt?.toISOString() ?? null, maxUses: row.maxUses },
          });
          return ctx.json(viewOf(row));
        },
      ),
      listJoinLinks: createAuthEndpoint(
        '/factory/join-links/list',
        { method: 'GET', query: z.object({ organizationId: z.string().min(1) }), use: [sessionMiddleware], requireHeaders: true },
        async ctx => {
          const { user } = sessionOf(ctx);
          await requireAdmin(ctx, ctx.query.organizationId, user.id);
          const rows = await ctx.context.adapter.findMany<JoinLinkRow>({
            model: 'joinLink',
            where: [{ field: 'organizationId', value: ctx.query.organizationId }],
            sortBy: { field: 'createdAt', direction: 'desc' },
          });
          return ctx.json({ joinLinks: rows.map(viewOf) });
        },
      ),
      revokeJoinLink: createAuthEndpoint(
        '/factory/join-links/revoke',
        { method: 'POST', body: z.object({ id: z.string().min(1) }), use: [sessionMiddleware], requireHeaders: true },
        async ctx => {
          const { user } = sessionOf(ctx);
          const row = await ctx.context.adapter.findOne<JoinLinkRow>({ model: 'joinLink', where: [{ field: 'id', value: ctx.body.id }] });
          if (!row) throw APIError.from('NOT_FOUND', { code: 'JOIN_LINK_NOT_FOUND', message: 'No such join link.' });
          await requireAdmin(ctx, row.organizationId, user.id);
          if (toDate(row.revokedAt)) return ctx.json(viewOf(row));
          const revokedAt = new Date();
          await ctx.context.adapter.updateMany({ model: 'joinLink', where: [{ field: 'id', value: row.id }], update: { revokedAt } });
          await relay.emit({
            action: 'factory.organization.join_link_revoked',
            organizationId: row.organizationId,
            actor: actorOf(user),
            targets: [{ type: 'join_link', id: row.id, name: row.name }],
          });
          return ctx.json(viewOf({ ...row, revokedAt }));
        },
      ),
      previewJoinLink: createAuthEndpoint(
        '/factory/join-links/preview',
        { method: 'GET', query: z.object({ token: z.string().min(1) }), use: [sessionMiddleware], requireHeaders: true },
        async ctx => {
          const { user } = sessionOf(ctx);
          const row = await findLinkByToken(ctx, ctx.query.token);
          if (!row) throw APIError.from('NOT_FOUND', { code: 'JOIN_LINK_NOT_FOUND', message: 'This join link does not exist.' });
          const organization = await ctx.context.adapter.findOne<OrganizationRow>({
            model: 'organization',
            where: [{ field: 'id', value: row.organizationId }],
          });
          if (!organization) throw APIError.from('NOT_FOUND', { code: 'ORGANIZATION_NOT_FOUND', message: 'The organization is gone.' });
          const member = await memberOf(ctx, row.organizationId, user.id);
          return ctx.json({
            organization: { id: organization.id, name: organization.name, logo: organization.logo ?? null },
            role: isAssignableRole(row.role) ? row.role : 'member',
            name: row.name,
            alreadyMember: Boolean(member),
            refusal: refusalFor(row, user),
          });
        },
      ),
      acceptJoinLink: createAuthEndpoint(
        '/factory/join-links/accept',
        { method: 'POST', body: z.object({ token: z.string().min(1) }), use: [sessionMiddleware], requireHeaders: true },
        async ctx => {
          const { user, session } = sessionOf(ctx);
          const row = await findLinkByToken(ctx, ctx.body.token);
          if (!row) throw APIError.from('NOT_FOUND', { code: 'JOIN_LINK_NOT_FOUND', message: 'This join link does not exist.' });
          const existing = await memberOf(ctx, row.organizationId, user.id);
          if (existing) {
            await ctx.context.internalAdapter.updateSession(session.token, { activeOrganizationId: row.organizationId } as never);
            return ctx.json({ organizationId: row.organizationId, role: existing.role, alreadyMember: true });
          }
          const refusal = refusalFor(row, user);
          if (refusal) throw refusalError(refusal);
          await takeOneUse(ctx, row);
          const member = await ctx.context.adapter.create<Omit<MemberRow, 'id'> & { createdAt: Date }, MemberRow>({
            model: 'member',
            data: { organizationId: row.organizationId, userId: user.id, role: row.role, createdAt: new Date() },
          });
          await ctx.context.internalAdapter.updateSession(session.token, { activeOrganizationId: row.organizationId } as never);
          relay.membershipChanged(row.organizationId, user.id);
          await relay.emit({
            action: 'factory.organization.join_link_used',
            organizationId: row.organizationId,
            actor: actorOf(user),
            targets: [
              { type: 'join_link', id: row.id, name: row.name },
              { type: 'member', id: user.id, ...(user.email ? { name: user.email } : {}) },
            ],
            metadata: { role: member.role },
          });
          return ctx.json({ organizationId: row.organizationId, role: member.role, alreadyMember: false });
        },
      ),
      uploadAvatar: createAuthEndpoint(
        '/factory/avatars',
        {
          method: 'POST',
          body: z.object({ dataUrl: z.string().min(1) }),
          use: [sessionMiddleware],
          requireHeaders: true,
        },
        async ctx => {
          const { user } = sessionOf(ctx);
          const { mimeType, data } = parseAvatarDataUrl(ctx.body.dataUrl);
          const row = await ctx.context.adapter.create<Record<string, unknown>, { id: string }>({
            model: 'factoryAvatar',
            data: { ownerUserId: user.id, mimeType, data, createdAt: new Date() },
          });
          return ctx.json({ id: row.id, url: avatarPath(ctx.context.options.basePath, row.id) });
        },
      ),
      getAvatar: createAuthEndpoint(
        '/factory/avatars/:id',
        { method: 'GET' },
        async ctx => {
          const id = (ctx.params as { id?: string } | undefined)?.id;
          if (!id) throw APIError.from('NOT_FOUND', { code: 'AVATAR_NOT_FOUND', message: 'No such avatar.' });
          const row = await ctx.context.adapter.findOne<{ id: string; mimeType: string; data: string }>({
            model: 'factoryAvatar',
            where: [{ field: 'id', value: id }],
          });
          if (!row) throw APIError.from('NOT_FOUND', { code: 'AVATAR_NOT_FOUND', message: 'No such avatar.' });
          return new Response(Buffer.from(row.data, 'base64'), {
            headers: {
              'Content-Type': row.mimeType,
              // An avatar never changes: a new picture is a new id.
              'Cache-Control': 'private, max-age=31536000, immutable',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

function avatarPath(basePath: string | undefined, id: string): string {
  return `${(basePath ?? '/api/auth').replace(/\/+$/, '')}/factory/avatars/${encodeURIComponent(id)}`;
}

/** A `data:` URL of a png, jpeg or webp image within the size limit, else a 400 naming why. */
export function parseAvatarDataUrl(dataUrl: string): { mimeType: (typeof AVATAR_TYPES)[number]; data: string } {
  const match = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw APIError.from('BAD_REQUEST', { code: 'INVALID_AVATAR', message: 'The avatar must be a base64 data URL.' });
  const mimeType = match[1] as (typeof AVATAR_TYPES)[number];
  if (!(AVATAR_TYPES as readonly string[]).includes(mimeType)) {
    throw APIError.from('BAD_REQUEST', { code: 'AVATAR_TYPE', message: 'The avatar must be a PNG, JPEG or WebP image.' });
  }
  const data = match[2] ?? '';
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0) throw APIError.from('BAD_REQUEST', { code: 'INVALID_AVATAR', message: 'The avatar is empty.' });
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw APIError.from('BAD_REQUEST', {
      code: 'AVATAR_TOO_LARGE',
      message: `The avatar is ${Math.ceil(bytes.length / 1024)} KB; the limit is ${AVATAR_MAX_BYTES / 1024} KB.`,
    });
  }
  if (!imageMagicMatches(mimeType, bytes)) {
    throw APIError.from('BAD_REQUEST', { code: 'AVATAR_TYPE', message: 'The avatar content does not match its image type.' });
  }
  return { mimeType, data: bytes.toString('base64') };
}

function imageMagicMatches(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

function refusalFor(row: JoinLinkRow, user: User): JoinRefusal | null {
  const status = joinLinkStatus(row);
  if (status !== 'active') return status;
  if (!user.emailVerified) return 'email_not_verified';
  if (!emailDomainAllowed(user.email, parseDomains(row.allowedDomains))) return 'domain_not_allowed';
  return null;
}

const REFUSAL_MESSAGES: Record<JoinRefusal, string> = {
  expired: 'This join link has expired.',
  revoked: 'This join link was revoked.',
  used_up: 'This join link has been used as many times as it allows.',
  domain_not_allowed: 'Your email domain is not allowed by this join link.',
  email_not_verified: 'Your email is not verified.',
};

function refusalError(refusal: JoinRefusal): APIError {
  return APIError.from('FORBIDDEN', { code: `JOIN_LINK_${refusal.toUpperCase()}`, message: REFUSAL_MESSAGES[refusal] });
}

/**
 * Counts one use with a conditional update (`uses` must still be what was
 * read), so concurrent accepts never go past the limit: the loser rereads and
 * tries again, or finds the link used up.
 */
async function takeOneUse(ctx: EndpointContext, row: JoinLinkRow): Promise<void> {
  let current = row;
  for (let attempt = 0; attempt < USE_INCREMENT_ATTEMPTS; attempt++) {
    const status = joinLinkStatus(current);
    if (status !== 'active') throw refusalError(status);
    const uses = Number(current.uses);
    const updated = await ctx.context.adapter.updateMany({
      model: 'joinLink',
      where: [
        { field: 'id', value: current.id },
        { field: 'uses', value: uses },
      ],
      update: { uses: uses + 1 },
    });
    if (updated === 1) return;
    const reread = await ctx.context.adapter.findOne<JoinLinkRow>({ model: 'joinLink', where: [{ field: 'id', value: current.id }] });
    if (!reread) throw APIError.from('NOT_FOUND', { code: 'JOIN_LINK_NOT_FOUND', message: 'This join link does not exist.' });
    current = reread;
  }
  throw APIError.from('SERVICE_UNAVAILABLE', {
    code: 'JOIN_LINK_BUSY',
    message: 'Too many people are joining with this link at once. Try again.',
  });
}
